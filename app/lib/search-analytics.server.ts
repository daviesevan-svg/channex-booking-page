// Guest search-demand analytics. Every availability search on the results page
// logs one row (dates, party, guest country, whether anything was bookable);
// the admin Analytics page aggregates them into the patterns a revenue manager
// cares about: when people want to arrive, how far ahead they shop, how long
// they stay, where they're from — and which dates turned shoppers away.
import { waitUntil } from "cloudflare:workers";

import { getDB } from "./config.server";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

let schemaReady = false;
/** Idempotently create the search_event table (same pattern as ari.server). */
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db().batch([
    db().prepare(
      `CREATE TABLE IF NOT EXISTS search_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        checkin TEXT NOT NULL,
        checkout TEXT NOT NULL,
        nights INTEGER NOT NULL,
        lead_days INTEGER NOT NULL,
        adults INTEGER NOT NULL,
        children INTEGER NOT NULL,
        country TEXT,
        lang TEXT,
        has_availability INTEGER NOT NULL,
        results_count INTEGER NOT NULL
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS search_event_prop_ts ON search_event (property_id, ts)`),
  ]);
  schemaReady = true;
}

export interface SearchEvent {
  propertyId: string;
  checkin: string;
  checkout: string;
  nights: number;
  /** Days between the search and the check-in date. */
  leadDays: number;
  adults: number;
  children: number;
  /** ISO 3166-1 alpha-2 from Cloudflare, e.g. "GB". */
  country: string | null;
  lang: string | null;
  hasAvailability: boolean;
  resultsCount: number;
}

/** Fire-and-forget: analytics must never break a guest search, so all failures
 *  are swallowed (D1 unconfigured in a fresh clone, transient errors, ...). */
export async function logSearchEvent(ev: SearchEvent): Promise<void> {
  try {
    await ensureSchema();
    await db()
      .prepare(
        `INSERT INTO search_event
          (property_id, ts, checkin, checkout, nights, lead_days, adults, children, country, lang, has_availability, results_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ev.propertyId,
        Date.now(),
        ev.checkin,
        ev.checkout,
        ev.nights,
        ev.leadDays,
        ev.adults,
        ev.children,
        ev.country,
        ev.lang,
        ev.hasAvailability ? 1 : 0,
        ev.resultsCount,
      )
      .run();
  } catch (err) {
    console.error("search analytics: failed to log event", err);
  }
}

/** Fire-and-forget wrapper: logs without delaying the guest's response. The
 *  write is kept alive past the response via waitUntil (falling back to a
 *  floating promise outside a request context, e.g. dev). */
export function queueSearchEvent(ev: SearchEvent): void {
  const work = logSearchEvent(ev);
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** Cron housekeeping: drop events older than the longest dashboard window (plus
 *  slack) so the table stays bounded. */
export async function pruneSearchEvents(maxAgeDays = 400): Promise<void> {
  await ensureSchema();
  await db().prepare(`DELETE FROM search_event WHERE ts < ?`).bind(Date.now() - maxAgeDays * 86_400_000).run();
}

// ---------------------------------------------------------------------------
// Aggregations for the admin dashboard. All scoped to a property + a trailing
// window in days, all plain GROUP BYs over the one table.

export interface SearchAnalytics {
  totals: {
    searches: number;
    withAvailability: number;
    /** Searches where nothing could be booked — lost demand. */
    lost: number;
    avgLeadDays: number | null;
    avgNights: number | null;
    avgParty: number | null;
    countries: number;
  };
  /** Searches per calendar day the search HAPPENED (activity over time). */
  perDay: { day: string; searches: number; lost: number }[];
  /** Most-searched arrival dates (demand calendar). */
  topArrivals: { checkin: string; searches: number; lost: number }[];
  /** Arrival-date day-of-week distribution, 0=Sunday … 6=Saturday. */
  arrivalDow: { dow: number; searches: number }[];
  /** How far ahead guests search. */
  leadBuckets: { bucket: string; searches: number }[];
  /** Length-of-stay distribution. */
  losBuckets: { bucket: string; searches: number }[];
  /** Guest countries by search volume. */
  countries: { country: string; searches: number; lost: number }[];
  /** Arrival dates with the most searches that found NOTHING bookable. */
  lostDates: { checkin: string; lost: number; total: number }[];
}

export async function getSearchAnalytics(propertyId: string, days: number): Promise<SearchAnalytics> {
  await ensureSchema();
  const since = Date.now() - days * 86_400_000;
  const d = db();

  const [totals, perDay, topArrivals, arrivalDow, leadBuckets, losBuckets, countries, lostDates] =
    await d.batch([
      d
        .prepare(
          `SELECT COUNT(*) AS searches,
                  SUM(has_availability) AS with_avail,
                  AVG(lead_days) AS avg_lead,
                  AVG(nights) AS avg_nights,
                  AVG(adults + children) AS avg_party,
                  COUNT(DISTINCT country) AS countries
           FROM search_event WHERE property_id = ? AND ts >= ?`,
        )
        .bind(propertyId, since),
      d
        .prepare(
          `SELECT date(ts / 1000, 'unixepoch') AS day,
                  COUNT(*) AS searches,
                  SUM(1 - has_availability) AS lost
           FROM search_event WHERE property_id = ? AND ts >= ?
           GROUP BY day ORDER BY day`,
        )
        .bind(propertyId, since),
      d
        .prepare(
          `SELECT checkin, COUNT(*) AS searches, SUM(1 - has_availability) AS lost
           FROM search_event WHERE property_id = ? AND ts >= ?
           GROUP BY checkin ORDER BY searches DESC, checkin LIMIT 14`,
        )
        .bind(propertyId, since),
      d
        .prepare(
          `SELECT CAST(strftime('%w', checkin) AS INTEGER) AS dow, COUNT(*) AS searches
           FROM search_event WHERE property_id = ? AND ts >= ?
           GROUP BY dow ORDER BY dow`,
        )
        .bind(propertyId, since),
      d
        .prepare(
          `SELECT CASE
                    WHEN lead_days <= 0 THEN 'Same day'
                    WHEN lead_days <= 3 THEN '1–3 days'
                    WHEN lead_days <= 7 THEN '4–7 days'
                    WHEN lead_days <= 14 THEN '1–2 weeks'
                    WHEN lead_days <= 30 THEN '2–4 weeks'
                    WHEN lead_days <= 60 THEN '1–2 months'
                    ELSE '2+ months'
                  END AS bucket,
                  MIN(lead_days) AS ord, COUNT(*) AS searches
           FROM search_event WHERE property_id = ? AND ts >= ?
           GROUP BY bucket ORDER BY ord`,
        )
        .bind(propertyId, since),
      d
        .prepare(
          `SELECT CASE
                    WHEN nights = 1 THEN '1 night'
                    WHEN nights = 2 THEN '2 nights'
                    WHEN nights = 3 THEN '3 nights'
                    WHEN nights <= 6 THEN '4–6 nights'
                    WHEN nights <= 13 THEN '1–2 weeks'
                    ELSE '2+ weeks'
                  END AS bucket,
                  MIN(nights) AS ord, COUNT(*) AS searches
           FROM search_event WHERE property_id = ? AND ts >= ?
           GROUP BY bucket ORDER BY ord`,
        )
        .bind(propertyId, since),
      d
        .prepare(
          `SELECT COALESCE(country, '??') AS country,
                  COUNT(*) AS searches, SUM(1 - has_availability) AS lost
           FROM search_event WHERE property_id = ? AND ts >= ?
           GROUP BY country ORDER BY searches DESC LIMIT 12`,
        )
        .bind(propertyId, since),
      d
        .prepare(
          `SELECT checkin, SUM(1 - has_availability) AS lost, COUNT(*) AS total
           FROM search_event WHERE property_id = ? AND ts >= ?
           GROUP BY checkin HAVING lost > 0
           ORDER BY lost DESC, checkin LIMIT 10`,
        )
        .bind(propertyId, since),
    ]);

  const t = (totals.results[0] ?? {}) as Record<string, number | null>;
  const searches = Number(t.searches ?? 0);
  const withAvail = Number(t.with_avail ?? 0);

  return {
    totals: {
      searches,
      withAvailability: withAvail,
      lost: searches - withAvail,
      avgLeadDays: t.avg_lead == null ? null : Math.round(Number(t.avg_lead)),
      avgNights: t.avg_nights == null ? null : Math.round(Number(t.avg_nights) * 10) / 10,
      avgParty: t.avg_party == null ? null : Math.round(Number(t.avg_party) * 10) / 10,
      countries: Number(t.countries ?? 0),
    },
    perDay: perDay.results as SearchAnalytics["perDay"],
    topArrivals: topArrivals.results as SearchAnalytics["topArrivals"],
    arrivalDow: arrivalDow.results as SearchAnalytics["arrivalDow"],
    leadBuckets: (leadBuckets.results as ({ bucket: string; searches: number } & { ord: number })[]).map(
      ({ bucket, searches }) => ({ bucket, searches }),
    ),
    losBuckets: (losBuckets.results as ({ bucket: string; searches: number } & { ord: number })[]).map(
      ({ bucket, searches }) => ({ bucket, searches }),
    ),
    countries: countries.results as SearchAnalytics["countries"],
    lostDates: lostDates.results as SearchAnalytics["lostDates"],
  };
}
