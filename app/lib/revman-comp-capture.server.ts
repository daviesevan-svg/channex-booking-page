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

import { getConfigKV, getDB } from "./config.server";
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

export interface CaptureRun {
  captured: number;
  spent: number;
  skippedFresh: number;
  /** True when we stopped because the wallet hit zero. */
  pausedNoTokens: boolean;
  error?: string;
}

/** Captures all dates in the horizon that are missing or stale, nearest-first,
 *  up to `max` per run (time budget). Each captured date costs 1 token; stops
 *  when the wallet is empty. `todayMs` is passed in (scripts can't call Date.now
 *  freely) — defaults to now. */
export async function captureDueDates(
  pid: string,
  opts: { max?: number; force?: boolean; actor?: string; nowMs?: number } = {},
): Promise<CaptureRun> {
  await ensureSchema();
  const run: CaptureRun = { captured: 0, spent: 0, skippedFresh: 0, pausedNoTokens: false };
  if (!isScrapflyConfigured()) return { ...run, error: "Scrapfly not configured." };

  const settings = await getCaptureSettings(pid);
  const [set, propSettings] = await Promise.all([getCompSet(pid), getSettings(pid)]);
  const currency = propSettings.currency || "GBP";
  // We price each hotel from its own Booking page (deterministic — a dated area
  // search only lists AVAILABLE hotels and caps at ~25, so a specific hotel can
  // be missing). Only hotels with a Booking reference can be located this way.
  const hotels = set.ranked
    .filter((h) => Boolean(h.bookingRef))
    .map((h) => ({ id: h.id, name: h.name, bookingRef: h.bookingRef as string }));
  if (hotels.length === 0) {
    return { ...run, error: "No hotels in the set have a Booking.com reference to price yet." };
  }

  const now = opts.nowMs ?? Date.now();
  const max = opts.max ?? settings.horizonDays;

  // Which dates already have a fresh capture?
  const from = iso(now);
  const to = iso(now + settings.horizonDays * DAY);
  const existing = await getCompPrices(pid, from, to);
  const freshestByDate = new Map<string, number>();
  for (const r of existing) {
    const t = Date.parse(r.capturedAt);
    if (!Number.isFinite(t)) continue;
    freshestByDate.set(r.date, Math.max(freshestByDate.get(r.date) ?? 0, t));
  }

  for (let d = 0; d < settings.horizonDays && run.captured < max; d++) {
    const date = iso(now + d * DAY);
    if (!opts.force) {
      const last = freshestByDate.get(date);
      if (last && now - last < freshnessMs(d, settings)) {
        run.skippedFresh++;
        continue;
      }
    }
    // Each date needs one token per hotel we can price.
    if ((await getBalance(pid)) < hotels.length) {
      run.pausedNoTokens = true;
      break;
    }
    for (const hotel of hotels) {
      const res = await captureHotelDate(pid, hotel, date, currency, opts.actor);
      if (res.charged) run.spent++;
      if (res.pausedNoTokens) {
        run.pausedNoTokens = true;
        break;
      }
    }
    if (run.pausedNoTokens) break;
    run.captured++;
  }
  return run;
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

/** Kicks off a capture run in the background (kept alive past the response via
 *  waitUntil) so the admin "Update prices now" click returns immediately. Each
 *  date persists as it's captured, so a time-capped run just resumes on the next
 *  click or cron tick (freshness-skip). */
export function startCaptureNow(pid: string, actor: string): void {
  const work = captureDueDates(pid, { actor }).then(() => {});
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** Cron entry: capture due dates for every connected property that has enabled
 *  automatic capture. Bounded per property per run so one slow property can't
 *  starve the others; the daily freshness window means unfinished windows fill
 *  over subsequent cron ticks. */
export async function scheduledCompCapture(perPropertyMax = 12): Promise<void> {
  if (!isScrapflyConfigured()) return;
  const props = await getProperties();
  for (const p of props) {
    try {
      const state = await getRevmanState(p.id);
      if (!state) continue;
      const settings = await getCaptureSettings(p.id);
      if (!settings.enabled) continue;
      if ((await getBalance(p.id)) < 1) continue; // paused; email handled elsewhere
      await captureDueDates(p.id, { max: perPropertyMax, actor: "cron" });
    } catch (err) {
      console.error(`[cron] comp capture failed for ${p.id}`, err);
    }
  }
}
