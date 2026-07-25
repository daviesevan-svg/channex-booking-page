// VR competitor capture — availability and price are captured SEPARATELY,
// because they have very different value-per-credit for a rental:
//
//   Availability (the important one — booking pace is inferred from it) comes
//   from Airbnb's per-listing availability calendar: ONE call returns up to a
//   year of per-day availability + minimum-stay for a listing (~25 credits, no
//   JS render). So it costs 1 token PER LISTING for the whole horizon, and the
//   horizon can be months rather than weeks.
//
//   Price comes from a dated area search (one call = every comp's price for one
//   date, but only that date). Rental prices move slowly, so these are sampled
//   on a coarse cadence (every Nth date over a shorter window) instead of daily.
//   A dated search also reveals availability for its date, so it doubles as the
//   fallback when the calendar API is unavailable.
//
// Both write a latest-state row plus an append-only snapshot, and the snapshots
// are what vr-pickup diffs into pace/pickup signals. Metering mirrors the hotel
// capture: debit → fetch → refund only on failure; freshness-skip so repeats and
// cron don't double-spend; resumable job so a horizon completes past the Worker
// time cap.
import { waitUntil } from "cloudflare:workers";

import { getConfig, getConfigKV, getDB } from "./config.server";
import { getSettings } from "./overrides.server";
import { getProperties } from "./properties.server";
import { getVrCompSet } from "./vr-compset.server";
import { discoverVrComps } from "./vr-compset-discovery.server";
import { discoverCalendarHash, fetchListingCalendar } from "./vr-calendar.server";
import { isScrapflyConfigured } from "./scrapfly.server";
import { debitTokens, creditTokens, getBalance } from "./revman-tokens.server";
import { analyzeSeries, paceByDate, pickupByDate, type AvailPoint, type DatePace, type DatePickup } from "./vr-pickup";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db().batch([
    db().prepare(
      `CREATE TABLE IF NOT EXISTS vr_comp_avail (
        pid TEXT NOT NULL, comp_id TEXT NOT NULL, date TEXT NOT NULL,
        available INTEGER NOT NULL, price_minor INTEGER, currency TEXT, captured_at TEXT NOT NULL,
        PRIMARY KEY (pid, comp_id, date)
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS vr_comp_avail_pid_date ON vr_comp_avail (pid, date)`),
    db().prepare(
      `CREATE TABLE IF NOT EXISTS vr_comp_avail_hist (
        pid TEXT NOT NULL, comp_id TEXT NOT NULL, date TEXT NOT NULL,
        available INTEGER NOT NULL, price_minor INTEGER, currency TEXT, captured_at TEXT NOT NULL,
        PRIMARY KEY (pid, comp_id, date, captured_at)
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS vr_comp_avail_hist_pid_date ON vr_comp_avail_hist (pid, date)`),
    // Prices live apart from availability: different source, different cadence.
    db().prepare(
      `CREATE TABLE IF NOT EXISTS vr_comp_price (
        pid TEXT NOT NULL, comp_id TEXT NOT NULL, date TEXT NOT NULL,
        price_minor INTEGER, currency TEXT, captured_at TEXT NOT NULL,
        PRIMARY KEY (pid, comp_id, date)
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS vr_comp_price_pid_date ON vr_comp_price (pid, date)`),
    db().prepare(
      `CREATE TABLE IF NOT EXISTS vr_comp_price_hist (
        pid TEXT NOT NULL, comp_id TEXT NOT NULL, date TEXT NOT NULL,
        price_minor INTEGER, currency TEXT, captured_at TEXT NOT NULL,
        PRIMARY KEY (pid, comp_id, date, captured_at)
      )`,
    ),
  ]);
  // Added after the first release — ALTER fails if already present, which is
  // fine (each runs independently so one "duplicate column" can't roll back the
  // others). min_nights is what lets us tell "booked" apart from "needs a
  // longer stay"; the legacy price columns on vr_comp_avail are now unused.
  await Promise.all([
    db().prepare(`ALTER TABLE vr_comp_avail ADD COLUMN min_nights INTEGER`).run().catch(() => {}),
    db().prepare(`ALTER TABLE vr_comp_avail ADD COLUMN bookable INTEGER`).run().catch(() => {}),
    db().prepare(`ALTER TABLE vr_comp_avail_hist ADD COLUMN min_nights INTEGER`).run().catch(() => {}),
  ]);
  schemaReady = true;
}

const HIST_KEEP_DAYS = 400;

// ---------------------------------------------------------------------------
// Settings (KV).

export interface VrCaptureSettings {
  /** Automatic (cron) capture. Manual runs work regardless. */
  enabled: boolean;
  /** Availability horizon. The calendar feed makes long horizons cheap — cost
   *  is per listing, not per date — so this can be months. */
  horizonDays: number;
  /** Refresh availability for a listing at most this often (days). */
  availCadenceDays: number;
  /** Capture prices at all. */
  priceEnabled: boolean;
  /** Sample a price every Nth date (rental prices move slowly). */
  priceCadenceDays: number;
  /** Only sample prices this far out (near dates are the actionable ones). */
  priceHorizonDays: number;
  /** Stay length used for price sampling searches. */
  nights: number;
  adults: number;
}

export const DEFAULT_VR_CAPTURE_SETTINGS: VrCaptureSettings = {
  enabled: false,
  horizonDays: 90,
  availCadenceDays: 1,
  priceEnabled: true,
  priceCadenceDays: 7,
  priceHorizonDays: 30,
  nights: 1,
  adults: 2,
};

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export async function getVrCaptureSettings(pid: string): Promise<VrCaptureSettings> {
  const kv = getConfigKV();
  if (!kv) return { ...DEFAULT_VR_CAPTURE_SETTINGS };
  const raw = await kv.get(`vrcap:${pid}`);
  if (!raw) return { ...DEFAULT_VR_CAPTURE_SETTINGS };
  try {
    const s = JSON.parse(raw) as Partial<VrCaptureSettings>;
    const d = DEFAULT_VR_CAPTURE_SETTINGS;
    return {
      enabled: Boolean(s.enabled),
      horizonDays: clampInt(s.horizonDays, 1, 365, d.horizonDays),
      availCadenceDays: clampInt(s.availCadenceDays, 1, 30, d.availCadenceDays),
      priceEnabled: s.priceEnabled ?? d.priceEnabled,
      priceCadenceDays: clampInt(s.priceCadenceDays, 1, 90, d.priceCadenceDays),
      priceHorizonDays: clampInt(s.priceHorizonDays, 1, 365, d.priceHorizonDays),
      nights: clampInt(s.nights, 1, 14, d.nights),
      adults: clampInt(s.adults, 1, 16, d.adults),
    };
  } catch {
    return { ...DEFAULT_VR_CAPTURE_SETTINGS };
  }
}

export async function setVrCaptureSettings(pid: string, patch: Partial<VrCaptureSettings>): Promise<VrCaptureSettings> {
  const kv = getConfigKV();
  const cur = await getVrCaptureSettings(pid);
  const num = (v: unknown, lo: number, hi: number, fallback: number) => (v !== undefined ? clampInt(v, lo, hi, fallback) : fallback);
  const next: VrCaptureSettings = {
    enabled: patch.enabled ?? cur.enabled,
    horizonDays: num(patch.horizonDays, 1, 365, cur.horizonDays),
    availCadenceDays: num(patch.availCadenceDays, 1, 30, cur.availCadenceDays),
    priceEnabled: patch.priceEnabled ?? cur.priceEnabled,
    priceCadenceDays: num(patch.priceCadenceDays, 1, 90, cur.priceCadenceDays),
    priceHorizonDays: num(patch.priceHorizonDays, 1, 365, cur.priceHorizonDays),
    nights: num(patch.nights, 1, 14, cur.nights),
    adults: num(patch.adults, 1, 16, cur.adults),
  };
  if (kv) await kv.put(`vrcap:${pid}`, JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------------------
// Reads.

export interface VrAvailRow {
  compId: string;
  date: string;
  available: number;
  minNights: number | null;
  capturedAt: string;
}

export async function getVrAvail(pid: string, from: string, to: string): Promise<VrAvailRow[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(
      `SELECT comp_id AS compId, date, available, min_nights AS minNights, captured_at AS capturedAt
       FROM vr_comp_avail WHERE pid = ? AND date >= ? AND date <= ? ORDER BY date`,
    )
    .bind(pid, from, to)
    .all<VrAvailRow>();
  return results ?? [];
}

export interface VrPriceRow {
  compId: string;
  date: string;
  priceMinor: number | null;
  currency: string | null;
  capturedAt: string;
}

export async function getVrPrices(pid: string, from: string, to: string): Promise<VrPriceRow[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(
      `SELECT comp_id AS compId, date, price_minor AS priceMinor, currency, captured_at AS capturedAt
       FROM vr_comp_price WHERE pid = ? AND date >= ? AND date <= ? ORDER BY date`,
    )
    .bind(pid, from, to)
    .all<VrPriceRow>();
  return results ?? [];
}

export async function lastVrCapturedAt(pid: string): Promise<string | null> {
  await ensureSchema();
  const row = await db()
    .prepare(`SELECT MAX(captured_at) AS ts FROM vr_comp_avail WHERE pid = ?`)
    .bind(pid)
    .first<{ ts: string | null }>();
  return row?.ts ?? null;
}

/** Availability snapshots for [from,to], shaped for the pure analysers. */
async function availSeries(pid: string, from: string, to: string): Promise<Map<string, AvailPoint[][]>> {
  await ensureSchema();
  const { results } = await db()
    .prepare(
      `SELECT comp_id AS compId, date, available, captured_at AS capturedAt
       FROM vr_comp_avail_hist WHERE pid = ? AND date >= ? AND date <= ? ORDER BY date, comp_id, captured_at`,
    )
    .bind(pid, from, to)
    .all<{ compId: string; date: string; available: number; capturedAt: string }>();

  const byDate = new Map<string, Map<string, AvailPoint[]>>();
  for (const r of results ?? []) {
    let comps = byDate.get(r.date);
    if (!comps) byDate.set(r.date, (comps = new Map()));
    let pts = comps.get(r.compId);
    if (!pts) comps.set(r.compId, (pts = []));
    pts.push({ capturedAt: r.capturedAt, available: r.available === 1 });
  }
  const shaped = new Map<string, AvailPoint[][]>();
  for (const [date, comps] of byDate) shaped.set(date, [...comps.values()]);
  return shaped;
}

/** Per-date competitor pickup (available→closed inference). */
export async function getMarketPickup(pid: string, from: string, to: string): Promise<DatePickup[]> {
  return pickupByDate(await availSeries(pid, from, to));
}

/** Per-date booking pace: occupancy, velocity and how the date compares to the
 *  market's own fill curve at the same days-before-arrival. */
export async function getMarketPace(pid: string, from: string, to: string, todayISO: string): Promise<DatePace[]> {
  return paceByDate(await availSeries(pid, from, to), todayISO);
}

export { analyzeSeries };

// ---------------------------------------------------------------------------
// Capture job.

const DAY = 86_400_000;
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const MAX_RANGE_DAYS = 365;
/** Calendar calls are light (no render); dated searches are heavy. */
const AVAIL_CONCURRENCY = 3;
const PRICE_CONCURRENCY = 2;
const WAVES_PER_CHUNK = 2;
const CHUNK_ACTIVE_MS = 90_000;

interface TrackedComp {
  compId: string;
  ref: string;
}

interface VrCaptureJob {
  from: string;
  to: string;
  area: string;
  nights: number;
  adults: number;
  /** Availability phase: one calendar call per listing. */
  comps: TrackedComp[];
  /** Price phase: the sampled dates only. */
  priceDates: string[];
  phase: "availability" | "price";
  ci: number;
  pi: number;
  total: number;
  done: number;
  spent: number;
  status: "running" | "done" | "paused" | "error";
  /** Id of the continuation currently working the job. Written before any paid
   *  work so a concurrent nudge can tell a runner is alive, and re-checked after
   *  each wave so a superseded runner stops instead of double-charging. */
  runner?: string;
  reason?: "no_tokens" | "provider" | "calendar_stale";
  /** Set when the calendar API rejected our query hash — availability for this
   *  run is only as dense as the price phase's dated searches. */
  calendarDegraded?: boolean;
  actor: string;
  startedAt: string;
  progressAt: string;
  error?: string;
}

const jobKey = (pid: string) => `vrcap-job:${pid}`;

async function getJob(pid: string): Promise<VrCaptureJob | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(jobKey(pid));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VrCaptureJob;
  } catch {
    return null;
  }
}
async function putJob(pid: string, job: VrCaptureJob): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(jobKey(pid), JSON.stringify(job));
}

export interface VrCaptureJobView {
  status: VrCaptureJob["status"];
  reason?: VrCaptureJob["reason"];
  phase: VrCaptureJob["phase"];
  calendarDegraded?: boolean;
  done: number;
  total: number;
  spent: number;
  from: string;
  to: string;
}

export async function getVrCaptureJob(pid: string): Promise<VrCaptureJobView | null> {
  const j = await getJob(pid);
  if (!j) return null;
  return {
    status: j.status,
    reason: j.reason,
    phase: j.phase,
    calendarDegraded: j.calendarDegraded,
    done: j.done,
    total: j.total,
    spent: j.spent,
    from: j.from,
    to: j.to,
  };
}

async function captureArea(pid: string): Promise<string> {
  const s = await getSettings(pid);
  return [s.addressCity, s.addressRegion, s.addressCountry].map((x) => (x ?? "").trim()).filter(Boolean).join(", ");
}

async function trackedComps(pid: string): Promise<TrackedComp[]> {
  const set = await getVrCompSet(pid);
  return set.ranked.filter((u) => u.airbnbRef).map((u) => ({ compId: u.id, ref: u.airbnbRef as string }));
}

/** Estimated token cost of a full run: one per listing (availability, whole
 *  horizon) plus one per sampled price date. */
export function estimateVrCost(compCount: number, s: VrCaptureSettings): { avail: number; price: number; total: number } {
  const avail = compCount;
  const price = s.priceEnabled ? Math.ceil(s.priceHorizonDays / s.priceCadenceDays) : 0;
  return { avail, price, total: avail + price };
}

export async function enqueueVrCaptureJob(pid: string, fromISO: string, toISO: string, actor: string): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema();
  if (!isScrapflyConfigured()) return { ok: false, error: "Scrapfly not configured." };

  const existing = await getJob(pid);
  if (existing && existing.status === "running" && Date.now() - Date.parse(existing.progressAt) < CHUNK_ACTIVE_MS) {
    return { ok: false, error: "A capture is already running." };
  }

  const area = await captureArea(pid);
  if (!area) return { ok: false, error: "Set the property's town/region first (Settings → General)." };
  const comps = await trackedComps(pid);
  if (comps.length === 0) return { ok: false, error: "No comparable listings with an Airbnb reference yet." };
  const settings = await getVrCaptureSettings(pid);

  const todayMs = Date.parse(`${iso(Date.now())}T00:00:00Z`);
  const startMs = Math.max(todayMs, Date.parse(`${fromISO}T00:00:00Z`));
  let endMs = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return { ok: false, error: "Invalid date range." };
  endMs = Math.min(endMs, startMs + (MAX_RANGE_DAYS - 1) * DAY);

  // Price dates: every Nth day within the (shorter) price horizon.
  const priceDates: string[] = [];
  if (settings.priceEnabled) {
    const priceEnd = Math.min(endMs, startMs + (settings.priceHorizonDays - 1) * DAY);
    for (let ms = startMs; ms <= priceEnd; ms += settings.priceCadenceDays * DAY) priceDates.push(iso(ms));
  }

  const now = new Date().toISOString();
  const job: VrCaptureJob = {
    from: iso(startMs),
    to: iso(endMs),
    area,
    nights: settings.nights,
    adults: settings.adults,
    comps,
    priceDates,
    phase: "availability",
    ci: 0,
    pi: 0,
    total: comps.length + priceDates.length,
    done: 0,
    spent: 0,
    status: "running",
    actor,
    startedAt: now,
    progressAt: now,
  };
  await putJob(pid, job);
  kickVrContinuation(pid);
  return { ok: true };
}

function kickVrContinuation(pid: string): void {
  const work = (async () => {
    const { hmacSha256Hex } = await import("./hmac.server");
    const sig = await hmacSha256Hex(getConfig().sessionSecret, `vrcap-continue:${pid}`);
    const base = getConfig().appUrl.replace(/\/+$/, "");
    await fetch(`${base}/api/vr-capture-continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid, sig }),
    });
  })().catch((err) => console.log(`[vrcap] continuation kick failed for ${pid}: ${err}`));
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

export async function continueVrCaptureJob(pid: string, opts: { onlyIfStale?: boolean } = {}): Promise<void> {
  const job = await getJob(pid);
  if (!job || job.status !== "running") return;
  if (opts.onlyIfStale && Date.now() - Date.parse(job.progressAt) < CHUNK_ACTIVE_MS) return;

  await ensureSchema();
  const settings = await getVrCaptureSettings(pid);
  let paused = false;
  let reason: VrCaptureJob["reason"];

  // Claim the job BEFORE any paid work: a chunk of JS-rendered searches can run
  // longer than CHUNK_ACTIVE_MS, and without this the page poll would start a
  // second runner that re-reads the same cursor and pays for the same work
  // again (observed: one date charged 30×).
  const runner = crypto.randomUUID();
  job.runner = runner;
  job.progressAt = new Date().toISOString();
  await putJob(pid, job);
  /** True when another continuation has taken the job over. */
  const superseded = async (): Promise<boolean> => {
    const cur = await getJob(pid);
    return Boolean(cur?.runner && cur.runner !== runner);
  };
  /** Persist the cursor (and a fresh heartbeat) before spending, so work is
   *  reserved: a duplicate runner resumes AFTER this batch rather than repeating
   *  it. Skipping an item on a crash is far cheaper than paying twice. */
  const reserve = async (): Promise<void> => {
    job.progressAt = new Date().toISOString();
    await putJob(pid, job);
  };

  for (let wave = 0; wave < WAVES_PER_CHUNK && !paused; wave++) {
    if (await superseded()) return;
    const balance = await getBalance(pid);
    if (balance < 1) {
      paused = true;
      reason = "no_tokens";
      break;
    }

    if (job.phase === "availability") {
      // Skip listings whose availability is still fresh (cadence-based).
      const fresh = await freshCompIds(pid, job.from, job.to, settings.availCadenceDays);
      const batch: TrackedComp[] = [];
      while (batch.length < Math.min(AVAIL_CONCURRENCY, balance) && job.ci < job.comps.length) {
        const comp = job.comps[job.ci];
        if (!fresh.has(comp.compId)) batch.push(comp);
        job.ci++;
        job.done++;
      }
      await reserve();
      if (batch.length) {
        const results = await Promise.all(batch.map((c) => captureListingAvailability(pid, c, job)));
        job.spent += results.filter((r) => r.charged).length;
        if (results.some((r) => r.hashStale)) {
          // The calendar query hash rotated. Try one auto-refresh; if that
          // fails, skip to the price phase (whose dated searches still yield
          // sparse availability) rather than burning tokens on doomed calls.
          const rediscovered = await discoverCalendarHash().catch(() => ({ ok: false as const }));
          if (!rediscovered.ok) {
            job.calendarDegraded = true;
            job.ci = job.comps.length;
            job.done = job.comps.length;
          }
        }
        if (results.some((r) => r.providerExhausted)) {
          paused = true;
          reason = "provider";
        } else if (results.some((r) => r.pausedNoTokens)) {
          paused = true;
          reason = "no_tokens";
        }
      }
      if (job.ci >= job.comps.length) job.phase = "price";
      continue;
    }

    // Price phase.
    if (job.pi >= job.priceDates.length) break;
    const batch: string[] = [];
    while (batch.length < Math.min(PRICE_CONCURRENCY, balance) && job.pi < job.priceDates.length) {
      batch.push(job.priceDates[job.pi]);
      job.pi++;
      job.done++;
    }
    await reserve();
    if (batch.length) {
      const results = await Promise.all(batch.map((d) => capturePriceForDate(pid, d, job)));
      job.spent += results.filter((r) => r.charged).length;
      if (results.some((r) => r.providerExhausted)) {
        paused = true;
        reason = "provider";
      } else if (results.some((r) => r.pausedNoTokens)) {
        paused = true;
        reason = "no_tokens";
      }
    }
  }

  // Another runner owns the job now — don't overwrite its progress or fork a
  // second continuation chain.
  if (await superseded()) return;

  const finished = job.ci >= job.comps.length && job.pi >= job.priceDates.length;
  job.reason = paused ? reason : job.calendarDegraded && finished ? "calendar_stale" : undefined;
  job.status = paused ? "paused" : finished ? "done" : "running";
  job.progressAt = new Date().toISOString();
  await putJob(pid, job);
  if (job.status === "running") kickVrContinuation(pid);
}

/** Comps whose availability was captured within the cadence window (so a rerun
 *  or cron tick doesn't re-charge for them). */
async function freshCompIds(pid: string, from: string, to: string, cadenceDays: number): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - cadenceDays * DAY + 2 * 3_600_000).toISOString();
  const { results } = await db()
    .prepare(
      `SELECT comp_id AS compId, MAX(captured_at) AS ts FROM vr_comp_avail
       WHERE pid = ? AND date >= ? AND date <= ? GROUP BY comp_id HAVING ts > ?`,
    )
    .bind(pid, from, to, cutoff)
    .all<{ compId: string; ts: string }>();
  return new Set((results ?? []).map((r) => r.compId));
}

export function nudgeVrCaptureJob(pid: string): void {
  const work = continueVrCaptureJob(pid, { onlyIfStale: true }).catch(() => {});
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** One calendar call → availability + min-stay for one listing across the whole
 *  job horizon. This is the cheap, dense path. */
async function captureListingAvailability(
  pid: string,
  comp: TrackedComp,
  job: VrCaptureJob,
): Promise<{ charged: boolean; pausedNoTokens?: boolean; providerExhausted?: boolean; hashStale?: boolean }> {
  const deb = await debitTokens(pid, 1, { reason: "capture", note: `vr avail ${comp.ref}`, actor: job.actor });
  if (!deb.ok) return { charged: false, pausedNoTokens: true };

  const months = Math.min(12, Math.ceil(((Date.parse(`${job.to}T00:00:00Z`) - Date.parse(`${job.from}T00:00:00Z`)) / DAY + 1) / 28) + 1);
  const res = await fetchListingCalendar(comp.ref, { fromISO: job.from, months });
  if (!res.ok) {
    await creditTokens(pid, 1, { reason: "refund", note: `vr calendar failed ${comp.ref}`, actor: "system" });
    const providerExhausted = /quota|upgrade to continue|too many requests|429/i.test(res.error ?? "");
    return { charged: false, providerExhausted, hashStale: res.hashStale };
  }

  const capturedAt = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const day of res.days) {
    if (day.date < job.from || day.date > job.to) continue;
    // `bookable` is the honest read of "can someone actually book this night";
    // `available` alone can be true on a night that fails the stay rules.
    const available = day.bookable ? 1 : 0;
    stmts.push(
      db()
        .prepare(
          `INSERT INTO vr_comp_avail (pid, comp_id, date, available, bookable, min_nights, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(pid, comp_id, date) DO UPDATE SET
             available = excluded.available, bookable = excluded.bookable,
             min_nights = excluded.min_nights, captured_at = excluded.captured_at`,
        )
        .bind(pid, comp.compId, day.date, available, day.bookable ? 1 : 0, day.minNights, capturedAt),
      db()
        .prepare(
          `INSERT OR IGNORE INTO vr_comp_avail_hist (pid, comp_id, date, available, min_nights, captured_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(pid, comp.compId, day.date, available, day.minNights, capturedAt),
    );
  }
  // D1 caps statements per batch; chunk to stay well inside it. A failed write
  // means we paid for data we didn't keep, so refund rather than swallow it.
  try {
    for (let i = 0; i < stmts.length; i += 100) await db().batch(stmts.slice(i, i + 100));
  } catch (err) {
    await creditTokens(pid, 1, { reason: "refund", note: `vr avail store failed ${comp.ref}`, actor: "system" });
    console.error(`[vrcap] availability write failed for ${comp.ref}`, err);
    return { charged: false };
  }
  return { charged: true };
}

/** One dated area search → every comp's price for that date (plus availability
 *  as a by-product, which is the fallback when the calendar API is down). */
async function capturePriceForDate(
  pid: string,
  date: string,
  job: VrCaptureJob,
): Promise<{ charged: boolean; pausedNoTokens?: boolean; providerExhausted?: boolean; skipped?: boolean }> {
  // The availability phase runs first, so we already know whether ANY comp can
  // be booked that night. If none can, there are no prices to read and a search
  // would burn a token for nothing — very common for near-term dates, which
  // sell out. (Skipped only when we actually hold calendar data for the date.)
  const cover = await db()
    .prepare(`SELECT COUNT(*) AS tracked, COALESCE(SUM(available), 0) AS available FROM vr_comp_avail WHERE pid = ? AND date = ?`)
    .bind(pid, date)
    .first<{ tracked: number; available: number }>();
  if (cover && Number(cover.tracked) > 0 && Number(cover.available) === 0) {
    return { charged: false, skipped: true };
  }

  const deb = await debitTokens(pid, 1, { reason: "capture", note: `vr price ${date}`, actor: job.actor });
  if (!deb.ok) return { charged: false, pausedNoTokens: true };

  const checkout = iso(Date.parse(`${date}T00:00:00Z`) + job.nights * DAY);
  const res = await discoverVrComps(job.area, { checkin: date, checkout, adults: job.adults });
  if (!res.ok) {
    await creditTokens(pid, 1, { reason: "refund", note: `vr price failed ${date}`, actor: "system" });
    const providerExhausted = /quota|upgrade to continue|too many requests|429/i.test(res.error ?? "");
    return { charged: false, providerExhausted };
  }

  const present = new Map<string, { minor: number | null; currency: string | null }>();
  for (const c of res.candidates) present.set(c.airbnbRef, { minor: c.priceMinor ?? null, currency: c.currency ?? null });

  const capturedAt = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const comp of job.comps) {
    const hit = present.get(comp.ref);
    if (hit) {
      stmts.push(
        db()
          .prepare(
            `INSERT INTO vr_comp_price (pid, comp_id, date, price_minor, currency, captured_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(pid, comp_id, date) DO UPDATE SET
               price_minor = excluded.price_minor, currency = excluded.currency, captured_at = excluded.captured_at`,
          )
          .bind(pid, comp.compId, date, hit.minor, hit.currency, capturedAt),
        db()
          .prepare(
            `INSERT OR IGNORE INTO vr_comp_price_hist (pid, comp_id, date, price_minor, currency, captured_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(pid, comp.compId, date, hit.minor, hit.currency, capturedAt),
      );
    }
    // Availability by-product — only recorded when the calendar path didn't
    // already cover this run, so a 1-night search's min-stay blind spot can't
    // overwrite the calendar's better answer.
    if (job.calendarDegraded) {
      stmts.push(
        db()
          .prepare(
            `INSERT INTO vr_comp_avail (pid, comp_id, date, available, captured_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(pid, comp_id, date) DO UPDATE SET
               available = excluded.available, captured_at = excluded.captured_at`,
          )
          .bind(pid, comp.compId, date, hit ? 1 : 0, capturedAt),
        db()
          .prepare(
            `INSERT OR IGNORE INTO vr_comp_avail_hist (pid, comp_id, date, available, captured_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(pid, comp.compId, date, hit ? 1 : 0, capturedAt),
      );
    }
  }
  try {
    for (let i = 0; i < stmts.length; i += 100) await db().batch(stmts.slice(i, i + 100));
  } catch (err) {
    await creditTokens(pid, 1, { reason: "refund", note: `vr price store failed ${date}`, actor: "system" });
    console.error(`[vrcap] price write failed for ${date}`, err);
    return { charged: false };
  }
  return { charged: true };
}

/** Cron: prune old snapshots, then keep a horizon-covering job moving for every
 *  single-unit property with automatic capture enabled and tokens to spend. */
export async function scheduledVrCapture(): Promise<void> {
  if (!isScrapflyConfigured()) return;
  await ensureSchema();
  const cutoff = new Date(Date.now() - HIST_KEEP_DAYS * DAY).toISOString();
  await Promise.all([
    db().prepare(`DELETE FROM vr_comp_avail_hist WHERE captured_at < ?`).bind(cutoff).run().catch((e) => console.error("[cron] vr avail prune", e)),
    db().prepare(`DELETE FROM vr_comp_price_hist WHERE captured_at < ?`).bind(cutoff).run().catch((e) => console.error("[cron] vr price prune", e)),
  ]);

  const props = await getProperties();
  for (const p of props) {
    try {
      const settings = await getSettings(p.id);
      if (settings.singleUnit !== true) continue;
      const cap = await getVrCaptureSettings(p.id);
      if (!cap.enabled) continue;
      if ((await getBalance(p.id)) < 1) continue;
      const job = await getJob(p.id);
      const active = job && job.status === "running" && Date.now() - Date.parse(job.progressAt) < CHUNK_ACTIVE_MS;
      if (active) {
        await continueVrCaptureJob(p.id);
      } else {
        const now = Date.now();
        await enqueueVrCaptureJob(p.id, iso(now), iso(now + (cap.horizonDays - 1) * DAY), "cron");
      }
    } catch (err) {
      console.error(`[cron] vr capture failed for ${p.id}`, err);
    }
  }
}
