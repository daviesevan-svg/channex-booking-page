// First-party booking-funnel analytics (see docs/internal-analytics.md).
//
// Guest requests log which funnel step they ARE (results → detail → cart →
// checkout → purchase); the dashboard derives drop-off and conversion from the
// furthest step each visit reached — a MAX() in SQL, not event-transition
// tracking, so it cannot drift from what the guest actually did.
//
// The privacy design is load-bearing: nothing is ever stored on the guest's
// device, and no durable identifier is stored here. Visits are keyed by a
// DAILY-ROTATING salted hash of IP + user agent (the Plausible/Matomo-cookieless
// pattern) — the raw IP never touches the table, and the key cannot follow
// anyone across days. This is what keeps the whole feature outside cookie
// consent. Do not add a visitor cookie, and do not add the booking reference to
// purchase rows: rows must stay unlinkable to an individual.
import { isbot } from "isbot";

import { getConfig } from "./config.server";
import { db, fireAndForget, schemaOnce } from "./d1.server";
import { hmacSha256Hex } from "./hmac.server";

/** Funnel steps in order. `rank` makes "furthest reached" a MAX() in SQL. */
export const FUNNEL_STEPS = ["results", "detail", "cart", "checkout", "purchase"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
const RANK: Record<FunnelStep, number> = { results: 1, detail: 2, cart: 3, checkout: 4, purchase: 5 };

/** Idempotently create the funnel_event table (same pattern as search_event). */
const ensureSchema = schemaOnce((d) => [
  d.prepare(
    `CREATE TABLE IF NOT EXISTS funnel_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        visit_key TEXT NOT NULL,
        step TEXT NOT NULL,
        step_rank INTEGER NOT NULL,
        source TEXT NOT NULL,
        checkin TEXT,
        nights INTEGER,
        adults INTEGER,
        children INTEGER,
        rooms INTEGER,
        room_id TEXT,
        value REAL,
        currency TEXT,
        country TEXT,
        lang TEXT,
        device TEXT
      )`,
  ),
  d.prepare(`CREATE INDEX IF NOT EXISTS funnel_event_prop_ts ON funnel_event (property_id, ts)`),
  d.prepare(`CREATE INDEX IF NOT EXISTS funnel_event_prop_visit ON funnel_event (property_id, visit_key)`),
]);

/** Per-request context for a loggable guest hit, or null when the request must
 *  not be logged (prefetches would count phantom visits; bots would inflate the
 *  funnel top and depress every conversion rate). */
export interface FunnelContext {
  /** Daily-rotating salted hash of IP+UA. Never store the inputs. */
  visitKey: string;
  country: string | null;
  device: "mobile" | "desktop";
}

export async function funnelContext(request: Request): Promise<FunnelContext | null> {
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  if (purpose.includes("prefetch")) return null;
  // isbot is what entry.server already trusts for SSR streaming decisions —
  // one bot definition across the app, not two drifting ones.
  const ua = request.headers.get("user-agent") || "";
  if (!ua || isbot(ua)) return null;
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "";
  // The salt is DERIVED (secret + UTC date), so daily rotation needs no storage
  // and no cron: tomorrow's key simply hashes differently. Computed once per
  // request; the checkout action stows it on the pending booking so the finalize
  // path (which may run from a webhook, with no guest request) reuses it —
  // which also pins the key across a midnight rotation mid-payment.
  const day = new Date().toISOString().slice(0, 10);
  const visitKey = (await hmacSha256Hex(getConfig().sessionSecret, `${day}|${ip}|${ua}`)).slice(0, 16);
  const mobile = request.headers.get("sec-ch-ua-mobile") === "?1" || /Mobi/i.test(ua);
  return {
    visitKey,
    country:
      request.headers.get("cf-ipcountry") ??
      (request as { cf?: { country?: string } }).cf?.country ??
      null,
    device: mobile ? "mobile" : "desktop",
  };
}

export interface FunnelEvent {
  propertyId: string;
  step: FunnelStep;
  /** Empty string for purchases with no web visit (API/agent bookings). */
  visitKey: string;
  source: "web" | "api";
  checkin?: string;
  nights?: number;
  adults?: number;
  children?: number;
  /** Cart lines at this step (rooms being booked, on purchase). */
  rooms?: number;
  /** The room being viewed (detail step). */
  roomId?: string;
  /** Money at stake: grand total at checkout / booked total on purchase. */
  value?: number;
  currency?: string;
  country?: string | null;
  lang?: string | null;
  device?: string | null;
}

/** Fire-and-forget: analytics must never break a guest page or a booking, so
 *  all failures are swallowed (D1 unconfigured in a fresh clone, transient
 *  errors, ...). */
export async function logFunnelEvent(ev: FunnelEvent): Promise<void> {
  try {
    await ensureSchema();
    await db()
      .prepare(
        `INSERT INTO funnel_event
          (property_id, ts, visit_key, step, step_rank, source, checkin, nights, adults, children, rooms, room_id, value, currency, country, lang, device)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ev.propertyId,
        Date.now(),
        ev.visitKey,
        ev.step,
        RANK[ev.step],
        ev.source,
        ev.checkin ?? null,
        ev.nights ?? null,
        ev.adults ?? null,
        ev.children ?? null,
        ev.rooms ?? null,
        ev.roomId ?? null,
        ev.value ?? null,
        ev.currency ?? null,
        ev.country ?? null,
        ev.lang ?? null,
        ev.device ?? null,
      )
      .run();
  } catch (err) {
    console.error("funnel analytics: failed to log event", err);
  }
}

/** Fire-and-forget wrapper: logs without delaying the guest's response.
 *  (logFunnelEvent catches internally, so the promise can't reject.) */
export function queueFunnelEvent(ev: FunnelEvent): void {
  fireAndForget(logFunnelEvent(ev));
}

/** Cron housekeeping: 3-month retention, per the memory budget for this table
 *  (docs/internal-analytics.md §6). The 2-day slack keeps a full 90-day
 *  dashboard window honest right up to the moment rows age out. */
export async function pruneFunnelEvents(maxAgeDays = 92): Promise<void> {
  await ensureSchema();
  await db().prepare(`DELETE FROM funnel_event WHERE ts < ?`).bind(Date.now() - maxAgeDays * 86_400_000).run();
}

// ---------------------------------------------------------------------------
// Aggregations for the admin dashboard.

export interface FunnelAnalytics {
  /** Web visits whose furthest step was ≥ each rank — a strictly narrowing funnel. */
  funnel: { step: FunnelStep; visits: number }[];
  totals: {
    bookings: number;
    revenue: number;
    /** Bookings arriving via the API/MCP (counted separately, not in the web funnel). */
    apiBookings: number;
    apiRevenue: number;
    /** Web visits that searched. Denominator for the conversion rate. */
    visits: number;
    /** purchases / visits, as a share of 1. Null with no visits. */
    conversion: number | null;
    avgBookingValue: number | null;
    /** Checkout value left behind by visits that reached checkout but never booked. */
    abandonedValue: number;
    abandonedCheckouts: number;
  };
  /** Bookings + revenue per calendar day (web + API). */
  perDay: { day: string; bookings: number; revenue: number }[];
  /** Visits and bookings by device class. */
  devices: { device: string; visits: number; bookings: number }[];
}

export async function getFunnelAnalytics(propertyId: string, days: number): Promise<FunnelAnalytics> {
  await ensureSchema();
  const since = Date.now() - days * 86_400_000;

  const [reached, purchases, perDay, devices, abandoned] = await Promise.all([
    // Furthest step per web visit, then a histogram over those maxima.
    db()
      .prepare(
        `SELECT reached, COUNT(*) AS n FROM (
           SELECT visit_key, MAX(step_rank) AS reached
           FROM funnel_event
           WHERE property_id = ? AND ts >= ? AND visit_key != ''
           GROUP BY visit_key
         ) GROUP BY reached`,
      )
      .bind(propertyId, since)
      .all<{ reached: number; n: number }>(),
    db()
      .prepare(
        `SELECT source, COUNT(*) AS n, COALESCE(SUM(value), 0) AS revenue
         FROM funnel_event
         WHERE property_id = ? AND ts >= ? AND step = 'purchase'
         GROUP BY source`,
      )
      .bind(propertyId, since)
      .all<{ source: string; n: number; revenue: number }>(),
    db()
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(*) AS bookings, COALESCE(SUM(value), 0) AS revenue
         FROM funnel_event
         WHERE property_id = ? AND ts >= ? AND step = 'purchase'
         GROUP BY day ORDER BY day`,
      )
      .bind(propertyId, since)
      .all<{ day: string; bookings: number; revenue: number }>(),
    db()
      .prepare(
        `SELECT device,
                COUNT(DISTINCT visit_key) AS visits,
                SUM(CASE WHEN step = 'purchase' THEN 1 ELSE 0 END) AS bookings
         FROM funnel_event
         WHERE property_id = ? AND ts >= ? AND visit_key != '' AND device IS NOT NULL
         GROUP BY device`,
      )
      .bind(propertyId, since)
      .all<{ device: string; visits: number; bookings: number }>(),
    // Money left at checkout: each non-booking visit's highest checkout total.
    db()
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(v), 0) AS total FROM (
           SELECT visit_key, MAX(value) AS v
           FROM funnel_event
           WHERE property_id = ? AND ts >= ? AND step = 'checkout' AND value IS NOT NULL
           GROUP BY visit_key
           HAVING visit_key NOT IN (
             SELECT visit_key FROM funnel_event
             WHERE property_id = ? AND ts >= ? AND step = 'purchase'
           )
         )`,
      )
      .bind(propertyId, since, propertyId, since)
      .all<{ n: number; total: number }>(),
  ]);

  // visits reaching ≥ rank r = Σ histogram buckets at or above r.
  const buckets = reached.results ?? [];
  const atOrAbove = (rank: number) =>
    buckets.reduce((s, b) => s + (Number(b.reached) >= rank ? Number(b.n) : 0), 0);
  const funnel = FUNNEL_STEPS.map((step) => ({ step, visits: atOrAbove(RANK[step]) }));

  const bySource = (s: string) => purchases.results?.find((p) => p.source === s);
  const web = bySource("web");
  const api = bySource("api");
  const bookings = Number(web?.n ?? 0);
  const revenue = Math.round(Number(web?.revenue ?? 0) * 100) / 100;
  const visits = atOrAbove(1);
  const ab = abandoned.results?.[0];

  return {
    funnel,
    totals: {
      bookings,
      revenue,
      apiBookings: Number(api?.n ?? 0),
      apiRevenue: Math.round(Number(api?.revenue ?? 0) * 100) / 100,
      visits,
      conversion: visits > 0 ? atOrAbove(RANK.purchase) / visits : null,
      avgBookingValue: bookings > 0 ? Math.round((revenue / bookings) * 100) / 100 : null,
      abandonedValue: Math.round(Number(ab?.total ?? 0) * 100) / 100,
      abandonedCheckouts: Number(ab?.n ?? 0),
    },
    perDay: (perDay.results ?? []).map((d) => ({
      day: d.day,
      bookings: Number(d.bookings),
      revenue: Math.round(Number(d.revenue) * 100) / 100,
    })),
    devices: (devices.results ?? []).map((d) => ({
      device: d.device,
      visits: Number(d.visits),
      bookings: Number(d.bookings),
    })),
  };
}
