// Competitor + own-hotel price capture. Each hotel is priced from its OWN
// Booking hotel page for a 1-night stay (deterministic: a dated area search only
// lists AVAILABLE hotels and caps at ~25, so a specific hotel can silently go
// missing). One hotel-day = one Scrapfly call = ONE token (see revman-tokens);
// a null price (no availability that night) is still a real data point and is
// kept. Prices land in rev_comp_price keyed on each comp row's id and are shown
// on the Rate Intelligence page.
//
// Metering is fail-safe: we debit a token, scrape, and REFUND only when the
// scrape itself failed — so hotels pay for data, not for errors, and the wallet
// can never go negative (the debit is the guard). Capture is idempotent per
// (date, day): a date within its freshness window is skipped, so cron top-ups
// and repeated "update now" clicks don't double-spend.
import { waitUntil } from "cloudflare:workers";

import { getConfig, getConfigKV, getDB } from "./config.server";
import { getSettings } from "./overrides.server";
import { getProperties } from "./properties.server";
import { getRevmanState } from "./revman.server";
import { getCompSet } from "./revman-compset.server";
import { buildHotelUrl, parseHotelCheapestPrice } from "./revman-compset-discovery.server";
import { scrapeUrl, isScrapflyConfigured } from "./scrapfly.server";
import { debitTokens, creditTokens, getBalance } from "./revman-tokens.server";

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
      `CREATE TABLE IF NOT EXISTS rev_comp_price (
        pid TEXT NOT NULL,
        comp_id TEXT NOT NULL,
        date TEXT NOT NULL,
        price_minor INTEGER,
        currency TEXT,
        captured_at TEXT NOT NULL,
        PRIMARY KEY (pid, comp_id, date)
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS rev_comp_price_pid_date ON rev_comp_price (pid, date)`),
  ]);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Capture settings (per property, in KV) — how far ahead and how often to scrape.

export interface CaptureSettings {
  /** Automatic (cron) capture on/off. Manual "update now" works regardless. */
  enabled: boolean;
  /** How many days ahead to keep prices for. */
  horizonDays: number;
  /** Dates within this many days are refreshed daily; beyond it, every
   *  farCadenceDays. */
  nearDays: number;
  /** Refresh cadence (in days) for dates beyond nearDays. */
  farCadenceDays: number;
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  enabled: false,
  horizonDays: 30,
  nearDays: 30,
  farCadenceDays: 7,
};

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export async function getCaptureSettings(pid: string): Promise<CaptureSettings> {
  const kv = getConfigKV();
  if (!kv) return { ...DEFAULT_CAPTURE_SETTINGS };
  const raw = await kv.get(`revcap:${pid}`);
  if (!raw) return { ...DEFAULT_CAPTURE_SETTINGS };
  try {
    const s = JSON.parse(raw) as Partial<CaptureSettings>;
    return {
      enabled: Boolean(s.enabled),
      horizonDays: clampInt(s.horizonDays, 1, 365, DEFAULT_CAPTURE_SETTINGS.horizonDays),
      nearDays: clampInt(s.nearDays, 1, 365, DEFAULT_CAPTURE_SETTINGS.nearDays),
      farCadenceDays: clampInt(s.farCadenceDays, 1, 90, DEFAULT_CAPTURE_SETTINGS.farCadenceDays),
    };
  } catch {
    return { ...DEFAULT_CAPTURE_SETTINGS };
  }
}

export async function setCaptureSettings(pid: string, patch: Partial<CaptureSettings>): Promise<CaptureSettings> {
  const kv = getConfigKV();
  const current = await getCaptureSettings(pid);
  const next: CaptureSettings = {
    enabled: patch.enabled ?? current.enabled,
    horizonDays: patch.horizonDays !== undefined ? clampInt(patch.horizonDays, 1, 365, current.horizonDays) : current.horizonDays,
    nearDays: patch.nearDays !== undefined ? clampInt(patch.nearDays, 1, 365, current.nearDays) : current.nearDays,
    farCadenceDays:
      patch.farCadenceDays !== undefined ? clampInt(patch.farCadenceDays, 1, 90, current.farCadenceDays) : current.farCadenceDays,
  };
  if (kv) await kv.put(`revcap:${pid}`, JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------------------
// Reads for the table.

export interface CompPriceRow {
  compId: string;
  date: string;
  priceMinor: number | null;
  currency: string | null;
  capturedAt: string;
}

export async function getCompPrices(pid: string, from: string, to: string): Promise<CompPriceRow[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(
      `SELECT comp_id AS compId, date, price_minor AS priceMinor, currency, captured_at AS capturedAt
       FROM rev_comp_price WHERE pid = ? AND date >= ? AND date <= ? ORDER BY date`,
    )
    .bind(pid, from, to)
    .all<CompPriceRow>();
  return results ?? [];
}

/** Most recent capture timestamp for the property (null when never captured). */
export async function lastCapturedAt(pid: string): Promise<string | null> {
  await ensureSchema();
  const row = await db()
    .prepare(`SELECT MAX(captured_at) AS ts FROM rev_comp_price WHERE pid = ?`)
    .bind(pid)
    .first<{ ts: string | null }>();
  return row?.ts ?? null;
}

// ---------------------------------------------------------------------------
// Capture.

const DAY = 86_400_000;
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Freshness window for a date `d` days ahead, in ms: near dates refresh daily,
 *  far dates every farCadenceDays. A date captured more recently than this is
 *  considered fresh and skipped. */
function freshnessMs(daysAhead: number, s: CaptureSettings): number {
  return (daysAhead <= s.nearDays ? 1 : s.farCadenceDays) * DAY - 2 * 3_600_000; // minus 2h slack
}

const MAX_RANGE_DAYS = 365;
/** Hotel-dates processed per continuation invocation. Each is one ~10s scrape,
 *  so a small chunk stays well under the Worker background time cap; the chain
 *  hops across fresh invocations to cover a whole range. */
const CHUNK_UNITS = 3;
/** If a job's progress was touched more recently than this, a drive-by nudge
 *  assumes a runner is alive and skips (so polls don't duplicate the chain). */
const CHUNK_ACTIVE_MS = 90_000;

interface CaptureJob {
  from: string;
  to: string;
  currency: string;
  hotels: { id: string; name: string; bookingRef: string }[];
  dates: string[];
  di: number; // current date index
  hi: number; // current hotel index within the date
  total: number; // total hotel-dates
  done: number; // hotel-dates finished (captured or skipped-fresh)
  spent: number; // tokens actually charged
  status: "running" | "done" | "paused" | "error";
  actor: string;
  startedAt: string;
  progressAt: string;
  error?: string;
}

const jobKey = (pid: string) => `revcap-job:${pid}`;

async function getJob(pid: string): Promise<CaptureJob | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(jobKey(pid));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CaptureJob;
  } catch {
    return null;
  }
}

async function putJob(pid: string, job: CaptureJob): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(jobKey(pid), JSON.stringify(job));
}

export interface CaptureJobView {
  status: CaptureJob["status"];
  done: number;
  total: number;
  spent: number;
  from: string;
  to: string;
}

/** The current capture job's progress (for the page's progress bar + polling). */
export async function getCaptureJob(pid: string): Promise<CaptureJobView | null> {
  const j = await getJob(pid);
  if (!j) return null;
  return { status: j.status, done: j.done, total: j.total, spent: j.spent, from: j.from, to: j.to };
}

/** Creates (or replaces) a capture job over [fromISO, toISO] and kicks the first
 *  chunk. Refuses to clobber a job that's actively running (a live runner). */
export async function enqueueCaptureJob(
  pid: string,
  fromISO: string,
  toISO: string,
  actor: string,
): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema();
  if (!isScrapflyConfigured()) return { ok: false, error: "Scrapfly not configured." };

  const existing = await getJob(pid);
  if (existing && existing.status === "running" && Date.now() - Date.parse(existing.progressAt) < CHUNK_ACTIVE_MS) {
    return { ok: false, error: "A capture is already running." };
  }

  const [set, propSettings] = await Promise.all([getCompSet(pid), getSettings(pid)]);
  const currency = propSettings.currency || "GBP";
  // Price each hotel from its own Booking page (deterministic — a dated area
  // search only lists AVAILABLE hotels and caps at ~25). Needs a Booking ref.
  const hotels = set.ranked
    .filter((h) => Boolean(h.bookingRef))
    .map((h) => ({ id: h.id, name: h.name, bookingRef: h.bookingRef as string }));
  if (hotels.length === 0) return { ok: false, error: "No hotels in the set have a Booking.com reference yet." };

  const todayMs = Date.parse(`${iso(Date.now())}T00:00:00Z`);
  const startMs = Math.max(todayMs, Date.parse(`${fromISO}T00:00:00Z`)); // never the past
  let endMs = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return { ok: false, error: "Invalid date range." };
  endMs = Math.min(endMs, startMs + (MAX_RANGE_DAYS - 1) * DAY);
  const dates: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += DAY) dates.push(iso(ms));

  const now = new Date().toISOString();
  const job: CaptureJob = {
    from: iso(startMs),
    to: iso(endMs),
    currency,
    hotels,
    dates,
    di: 0,
    hi: 0,
    total: dates.length * hotels.length,
    done: 0,
    spent: 0,
    status: "running",
    actor,
    startedAt: now,
    progressAt: now,
  };
  await putJob(pid, job);
  kickCaptureContinuation(pid);
  return { ok: true };
}

/** Fire-and-forget self-fetch so the next chunk runs in a fresh invocation with
 *  fresh limits (signed with the session secret; the page poll is the backup). */
function kickCaptureContinuation(pid: string): void {
  const work = (async () => {
    const { hmacSha256Hex } = await import("./hmac.server");
    const sig = await hmacSha256Hex(getConfig().sessionSecret, `revcap-continue:${pid}`);
    const base = getConfig().appUrl.replace(/\/+$/, "");
    await fetch(`${base}/api/revman-capture-continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid, sig }),
    });
  })().catch((err) => console.log(`[revcap] continuation kick failed for ${pid}: ${err}`));
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** Processes one CHUNK_UNITS-sized slice of the current job and chains the next.
 *  `onlyIfStale` is the page-poll drive-by: skips when a runner looks alive. */
export async function continueCaptureJob(pid: string, opts: { onlyIfStale?: boolean } = {}): Promise<void> {
  const job = await getJob(pid);
  if (!job || job.status !== "running") return;
  if (opts.onlyIfStale && Date.now() - Date.parse(job.progressAt) < CHUNK_ACTIVE_MS) return;

  await ensureSchema();
  const settings = await getCaptureSettings(pid);
  const todayMs = Date.parse(`${iso(Date.now())}T00:00:00Z`);

  // Freshness map so a resumed/re-run job doesn't re-charge fresh (comp,date)s.
  const existing = await getCompPrices(pid, job.from, job.to);
  const fresh = new Map<string, number>();
  for (const r of existing) {
    const t = Date.parse(r.capturedAt);
    if (Number.isFinite(t)) fresh.set(`${r.compId}|${r.date}`, t);
  }

  let units = 0;
  const now = Date.now();
  while (units < CHUNK_UNITS && job.di < job.dates.length) {
    const date = job.dates[job.di];
    const hotel = job.hotels[job.hi];
    const daysAhead = Math.round((Date.parse(`${date}T00:00:00Z`) - todayMs) / DAY);
    const last = fresh.get(`${hotel.id}|${date}`);
    const isFresh = last && now - last < freshnessMs(daysAhead, settings);

    if (!isFresh) {
      if ((await getBalance(pid)) < 1) {
        job.status = "paused";
        job.progressAt = new Date().toISOString();
        await putJob(pid, job);
        return; // no continuation — resumes when topped up + re-run
      }
      const res = await captureHotelDate(pid, hotel, date, job.currency, job.actor);
      if (res.charged) job.spent++;
      units++;
    }
    job.done++;
    // advance cursor
    job.hi++;
    if (job.hi >= job.hotels.length) {
      job.hi = 0;
      job.di++;
    }
  }

  job.status = job.di >= job.dates.length ? "done" : "running";
  job.progressAt = new Date().toISOString();
  await putJob(pid, job);
  if (job.status === "running") kickCaptureContinuation(pid);
}

/** Drive-by nudge from the page poll — keeps the chain moving even if the signed
 *  self-fetch can't reach the Worker; skips when a runner is already alive. */
export function nudgeCaptureJob(pid: string): void {
  const work = continueCaptureJob(pid, { onlyIfStale: true }).catch(() => {});
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** Prices one hotel for one date from its Booking hotel page. Reserves a token
 *  (the debit is the concurrency-safe guard), scrapes, and refunds if the scrape
 *  itself failed. A null price (hotel has no availability that night) is stored
 *  and NOT refunded — that's a real, useful data point. */
async function captureHotelDate(
  pid: string,
  hotel: { id: string; name: string; bookingRef: string },
  date: string,
  currency: string,
  actor?: string,
): Promise<{ charged: boolean; pausedNoTokens?: boolean }> {
  const deb = await debitTokens(pid, 1, { reason: "capture", note: `${date} · ${hotel.name}`, actor: actor ?? "system" });
  if (!deb.ok) return { charged: false, pausedNoTokens: true };

  const checkout = iso(Date.parse(`${date}T00:00:00Z`) + DAY);
  const url = buildHotelUrl(hotel.bookingRef, { checkin: date, checkout, adults: 2, currency });
  const scrape = await scrapeUrl(url, {
    asp: true,
    renderJs: true, // hotel pages 202-challenge without a real render; JS render passes it (~6 credits)
    proxyPool: "public_residential_pool",
    country: currency === "GBP" ? "gb" : undefined,
    format: "raw",
    timeoutMs: 60_000,
  });
  if (!scrape.ok) {
    await creditTokens(pid, 1, { reason: "refund", note: `scrape failed ${date} · ${hotel.name}`, actor: "system" });
    return { charged: false };
  }

  const price = parseHotelCheapestPrice(scrape.content);
  await db()
    .prepare(
      `INSERT INTO rev_comp_price (pid, comp_id, date, price_minor, currency, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pid, comp_id, date) DO UPDATE SET
         price_minor = excluded.price_minor, currency = excluded.currency, captured_at = excluded.captured_at`,
    )
    .bind(pid, hotel.id, date, price?.minor ?? null, price?.currency ?? null, new Date().toISOString())
    .run();
  return { charged: true };
}

/** Cron entry: for every connected property with automatic capture enabled and
 *  tokens to spend, ensure a job covering the settings horizon exists and nudge
 *  it along. The resumable chain + freshness-skip mean an unfinished horizon
 *  fills over subsequent cron ticks without re-charging fresh dates. */
export async function scheduledCompCapture(): Promise<void> {
  if (!isScrapflyConfigured()) return;
  const props = await getProperties();
  for (const p of props) {
    try {
      const state = await getRevmanState(p.id);
      if (!state) continue;
      const settings = await getCaptureSettings(p.id);
      if (!settings.enabled) continue;
      if ((await getBalance(p.id)) < 1) continue; // paused; email handled elsewhere
      const job = await getJob(p.id);
      const active = job && job.status === "running" && Date.now() - Date.parse(job.progressAt) < CHUNK_ACTIVE_MS;
      if (active) {
        await continueCaptureJob(p.id); // keep an in-flight job moving
      } else {
        const now = Date.now();
        await enqueueCaptureJob(p.id, iso(now), iso(now + (settings.horizonDays - 1) * DAY), "cron");
      }
    } catch (err) {
      console.error(`[cron] comp capture failed for ${p.id}`, err);
    }
  }
}
