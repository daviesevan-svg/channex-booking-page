// VR competitor availability + price capture. For each stay-date we run ONE
// dated Airbnb area search (via Scrapfly): it returns exactly the listings
// AVAILABLE for that date, each with a price for those dates. So one scrape
// prices AND checks availability for the whole comp set at once — cheaper than
// the hotel per-hotel-page model. 1 date = 1 Scrapfly call = 1 token.
//
// We record, per tracked comp, available (present in the search) + its price,
// into vr_comp_avail (latest) and an append-only vr_comp_avail_hist (snapshots).
// Diffing snapshots over time yields the "available→closed = likely booked"
// signal (see vr-pickup). Metering mirrors the hotel capture: debit → scrape →
// refund only on scrape failure; freshness-skip so repeats/cron don't
// double-spend; resumable job so a horizon completes past the Worker time cap.
import { waitUntil } from "cloudflare:workers";

import { getConfig, getConfigKV, getDB } from "./config.server";
import { getSettings } from "./overrides.server";
import { getProperties } from "./properties.server";
import { getVrCompSet } from "./vr-compset.server";
import { discoverVrComps } from "./vr-compset-discovery.server";
import { isScrapflyConfigured } from "./scrapfly.server";
import { debitTokens, creditTokens, getBalance } from "./revman-tokens.server";
import { analyzeSeries, pickupByDate, type AvailPoint, type DatePickup } from "./vr-pickup";

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
    // Append-only snapshots — the raw series the pickup inference diffs.
    db().prepare(
      `CREATE TABLE IF NOT EXISTS vr_comp_avail_hist (
        pid TEXT NOT NULL, comp_id TEXT NOT NULL, date TEXT NOT NULL,
        available INTEGER NOT NULL, price_minor INTEGER, currency TEXT, captured_at TEXT NOT NULL,
        PRIMARY KEY (pid, comp_id, date, captured_at)
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS vr_comp_avail_hist_pid_date ON vr_comp_avail_hist (pid, date)`),
  ]);
  schemaReady = true;
}

const HIST_KEEP_DAYS = 400;

// ---------------------------------------------------------------------------
// Settings (KV).

export interface VrCaptureSettings {
  enabled: boolean;
  horizonDays: number;
  /** Stay length searched per date. 1 night is the sharpest availability probe;
   *  a longer stay includes more min-stay listings but attributes a booking to
   *  a window rather than a night. */
  nights: number;
  adults: number;
  nearDays: number;
  farCadenceDays: number;
}

export const DEFAULT_VR_CAPTURE_SETTINGS: VrCaptureSettings = {
  enabled: false,
  horizonDays: 30,
  nights: 1,
  adults: 2,
  nearDays: 30,
  farCadenceDays: 7,
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
    return {
      enabled: Boolean(s.enabled),
      horizonDays: clampInt(s.horizonDays, 1, 365, DEFAULT_VR_CAPTURE_SETTINGS.horizonDays),
      nights: clampInt(s.nights, 1, 14, DEFAULT_VR_CAPTURE_SETTINGS.nights),
      adults: clampInt(s.adults, 1, 16, DEFAULT_VR_CAPTURE_SETTINGS.adults),
      nearDays: clampInt(s.nearDays, 1, 365, DEFAULT_VR_CAPTURE_SETTINGS.nearDays),
      farCadenceDays: clampInt(s.farCadenceDays, 1, 90, DEFAULT_VR_CAPTURE_SETTINGS.farCadenceDays),
    };
  } catch {
    return { ...DEFAULT_VR_CAPTURE_SETTINGS };
  }
}

export async function setVrCaptureSettings(pid: string, patch: Partial<VrCaptureSettings>): Promise<VrCaptureSettings> {
  const kv = getConfigKV();
  const cur = await getVrCaptureSettings(pid);
  const next: VrCaptureSettings = {
    enabled: patch.enabled ?? cur.enabled,
    horizonDays: patch.horizonDays !== undefined ? clampInt(patch.horizonDays, 1, 365, cur.horizonDays) : cur.horizonDays,
    nights: patch.nights !== undefined ? clampInt(patch.nights, 1, 14, cur.nights) : cur.nights,
    adults: patch.adults !== undefined ? clampInt(patch.adults, 1, 16, cur.adults) : cur.adults,
    nearDays: patch.nearDays !== undefined ? clampInt(patch.nearDays, 1, 365, cur.nearDays) : cur.nearDays,
    farCadenceDays: patch.farCadenceDays !== undefined ? clampInt(patch.farCadenceDays, 1, 90, cur.farCadenceDays) : cur.farCadenceDays,
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
  priceMinor: number | null;
  currency: string | null;
  capturedAt: string;
}

export async function getVrAvail(pid: string, from: string, to: string): Promise<VrAvailRow[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(
      `SELECT comp_id AS compId, date, available, price_minor AS priceMinor, currency, captured_at AS capturedAt
       FROM vr_comp_avail WHERE pid = ? AND date >= ? AND date <= ? ORDER BY date`,
    )
    .bind(pid, from, to)
    .all<VrAvailRow>();
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

/** Per-date competitor pickup (available→closed inference) over [from,to],
 *  built from the snapshot history. */
export async function getMarketPickup(pid: string, from: string, to: string): Promise<DatePickup[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(
      `SELECT comp_id AS compId, date, available, captured_at AS capturedAt
       FROM vr_comp_avail_hist WHERE pid = ? AND date >= ? AND date <= ? ORDER BY date, comp_id, captured_at`,
    )
    .bind(pid, from, to)
    .all<{ compId: string; date: string; available: number; capturedAt: string }>();

  // byDate: date -> (compId -> AvailPoint[])
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
  return pickupByDate(shaped);
}

// re-export so the route can analyse a single comp's series if needed
export { analyzeSeries };

// ---------------------------------------------------------------------------
// Capture job.

const DAY = 86_400_000;
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const MAX_RANGE_DAYS = 365;
/** Dated searches use render_js (~heavy); keep concurrency low. */
const CONCURRENCY = 2;
const WAVES_PER_CHUNK = 2;
const CHUNK_ACTIVE_MS = 90_000;

function freshnessMs(daysAhead: number, s: VrCaptureSettings): number {
  return (daysAhead <= s.nearDays ? 1 : s.farCadenceDays) * DAY - 2 * 3_600_000;
}

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
  comps: TrackedComp[];
  dates: string[];
  di: number;
  total: number;
  done: number;
  spent: number;
  status: "running" | "done" | "paused" | "error";
  reason?: "no_tokens" | "provider" | "no_comps" | "no_area";
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
  done: number;
  total: number;
  spent: number;
  from: string;
  to: string;
}

export async function getVrCaptureJob(pid: string): Promise<VrCaptureJobView | null> {
  const j = await getJob(pid);
  if (!j) return null;
  return { status: j.status, reason: j.reason, done: j.done, total: j.total, spent: j.spent, from: j.from, to: j.to };
}

/** The comp set's area (town/region/country) from settings. */
async function captureArea(pid: string): Promise<string> {
  const s = await getSettings(pid);
  return [s.addressCity, s.addressRegion, s.addressCountry].map((x) => (x ?? "").trim()).filter(Boolean).join(", ");
}

/** Tracked comps = every set member (incl. self) that has an Airbnb ref — the
 *  only ones identifiable in a search. */
async function trackedComps(pid: string): Promise<TrackedComp[]> {
  const set = await getVrCompSet(pid);
  return set.ranked.filter((u) => u.airbnbRef).map((u) => ({ compId: u.id, ref: u.airbnbRef as string }));
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
  const dates: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += DAY) dates.push(iso(ms));

  const now = new Date().toISOString();
  const job: VrCaptureJob = {
    from: iso(startMs), to: iso(endMs), area, nights: settings.nights, adults: settings.adults,
    comps, dates, di: 0, total: dates.length, done: 0, spent: 0, status: "running",
    actor, startedAt: now, progressAt: now,
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
  const todayMs = Date.parse(`${iso(Date.now())}T00:00:00Z`);

  // Freshness map (per date, the newest capture time) so a resumed/re-run job
  // skips still-fresh dates instead of re-charging.
  const existing = await getVrAvail(pid, job.from, job.to);
  const freshByDate = new Map<string, number>();
  for (const r of existing) {
    const t = Date.parse(r.capturedAt);
    if (Number.isFinite(t)) freshByDate.set(r.date, Math.max(freshByDate.get(r.date) ?? 0, t));
  }

  const now = Date.now();
  let paused = false;
  let reason: VrCaptureJob["reason"];
  for (let wave = 0; wave < WAVES_PER_CHUNK && job.di < job.dates.length && !paused; wave++) {
    const balance = await getBalance(pid);
    if (balance < 1) {
      paused = true;
      reason = "no_tokens";
      break;
    }
    const cap = Math.min(CONCURRENCY, balance);
    const batch: string[] = [];
    while (batch.length < cap && job.di < job.dates.length) {
      const date = job.dates[job.di];
      const daysAhead = Math.round((Date.parse(`${date}T00:00:00Z`) - todayMs) / DAY);
      const last = freshByDate.get(date);
      if (!(last && now - last < freshnessMs(daysAhead, settings))) batch.push(date);
      job.done++;
      job.di++;
    }
    if (batch.length) {
      const results = await Promise.all(batch.map((d) => captureDate(pid, d, job)));
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

  job.reason = paused ? reason : undefined;
  job.status = paused ? "paused" : job.di >= job.dates.length ? "done" : "running";
  job.progressAt = new Date().toISOString();
  await putJob(pid, job);
  if (job.status === "running") kickVrContinuation(pid);
}

export function nudgeVrCaptureJob(pid: string): void {
  const work = continueVrCaptureJob(pid, { onlyIfStale: true }).catch(() => {});
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** One dated area search → availability + price for every tracked comp on that
 *  date. Reserves a token, scrapes, refunds only if the scrape failed. */
async function captureDate(
  pid: string,
  date: string,
  job: VrCaptureJob,
): Promise<{ charged: boolean; pausedNoTokens?: boolean; providerExhausted?: boolean }> {
  const deb = await debitTokens(pid, 1, { reason: "capture", note: `vr ${date}`, actor: job.actor });
  if (!deb.ok) return { charged: false, pausedNoTokens: true };

  const checkout = iso(Date.parse(`${date}T00:00:00Z`) + job.nights * DAY);
  const res = await discoverVrComps(job.area, { checkin: date, checkout, adults: job.adults });
  if (!res.ok) {
    await creditTokens(pid, 1, { reason: "refund", note: `vr scrape failed ${date}`, actor: "system" });
    const providerExhausted = /quota|upgrade to continue|too many requests|429/i.test(res.error ?? "");
    return { charged: false, providerExhausted };
  }

  // Listings present in a dated search are AVAILABLE for that date; map ref → price.
  const present = new Map<string, { minor: number | null; currency: string | null }>();
  for (const c of res.candidates) present.set(c.airbnbRef, { minor: c.priceMinor ?? null, currency: c.currency ?? null });

  const capturedAt = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const comp of job.comps) {
    const hit = present.get(comp.ref);
    const available = hit ? 1 : 0;
    const priceMinor = hit?.minor ?? null;
    const currency = hit?.currency ?? null;
    stmts.push(
      db()
        .prepare(
          `INSERT INTO vr_comp_avail (pid, comp_id, date, available, price_minor, currency, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(pid, comp_id, date) DO UPDATE SET
             available = excluded.available, price_minor = excluded.price_minor,
             currency = excluded.currency, captured_at = excluded.captured_at`,
        )
        .bind(pid, comp.compId, date, available, priceMinor, currency, capturedAt),
      db()
        .prepare(
          `INSERT OR IGNORE INTO vr_comp_avail_hist (pid, comp_id, date, available, price_minor, currency, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(pid, comp.compId, date, available, priceMinor, currency, capturedAt),
    );
  }
  if (stmts.length) await db().batch(stmts);
  return { charged: true };
}

/** Cron: prune old history, then for each single-unit property with automatic
 *  capture on and tokens to spend, keep a horizon-covering job moving. */
export async function scheduledVrCapture(): Promise<void> {
  if (!isScrapflyConfigured()) return;
  await ensureSchema();
  await db()
    .prepare(`DELETE FROM vr_comp_avail_hist WHERE captured_at < ?`)
    .bind(new Date(Date.now() - HIST_KEEP_DAYS * DAY).toISOString())
    .run()
    .catch((err) => console.error("[cron] vr avail history prune failed", err));

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
