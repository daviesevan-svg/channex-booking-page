// Collection landing-page analytics. Each visit to a /c/:slug collection page
// logs one "view" row (with or without a date search, plus how many member
// stays were available and where the visitor is from); clicking through to a
// member property logs a "click" row. The admin Collection Analytics page turns
// these into the engagement picture an owner cares about: how much traffic the
// landing gets, how often visitors run a dated availability search, which stays
// pull the clicks, when guests want to arrive and where they come from.
//
// Same shape as search-analytics.server: a lazily-created D1 table, fire-and-
// forget capture that never breaks a guest page, GROUP-BY aggregations for the
// dashboard, and a cron prune. No PII — country is coarse ISO alpha-2 from
// Cloudflare, no IP stored.
import { waitUntil } from "cloudflare:workers";

import { getDB } from "./config.server";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

let schemaReady = false;
/** Idempotently create the collection_event table (same pattern as ari.server). */
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db().batch([
    db().prepare(
      `CREATE TABLE IF NOT EXISTS collection_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_slug TEXT NOT NULL,
        ts INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        property_id TEXT,
        has_dates INTEGER NOT NULL,
        nights INTEGER,
        lead_days INTEGER,
        adults INTEGER,
        children INTEGER,
        available_count INTEGER,
        property_count INTEGER,
        country TEXT,
        lang TEXT
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS collection_event_slug_ts ON collection_event (collection_slug, ts)`),
  ]);
  schemaReady = true;
}

export type CollectionEventType = "view" | "click";

export interface CollectionEvent {
  slug: string;
  type: CollectionEventType;
  /** Member property id — set for "click", null for "view". */
  propertyId?: string | null;
  /** Was the landing scoped to a date search (availability check)? */
  hasDates: boolean;
  nights?: number | null;
  /** Days between the visit and the searched check-in date (dated visits only). */
  leadDays?: number | null;
  adults?: number | null;
  children?: number | null;
  /** Member stays bookable at view time (dated) / total members (undated). */
  availableCount?: number | null;
  /** Total member properties in the collection. */
  propertyCount?: number | null;
  /** ISO 3166-1 alpha-2 from Cloudflare, e.g. "GB". */
  country?: string | null;
  lang?: string | null;
}

/** Fire-and-forget: analytics must never break a landing page, so all failures
 *  are swallowed (D1 unconfigured in a fresh clone, transient errors, ...). */
export async function logCollectionEvent(ev: CollectionEvent): Promise<void> {
  try {
    await ensureSchema();
    await db()
      .prepare(
        `INSERT INTO collection_event
          (collection_slug, ts, event_type, property_id, has_dates, nights, lead_days,
           adults, children, available_count, property_count, country, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ev.slug,
        Date.now(),
        ev.type,
        ev.propertyId ?? null,
        ev.hasDates ? 1 : 0,
        ev.nights ?? null,
        ev.leadDays ?? null,
        ev.adults ?? null,
        ev.children ?? null,
        ev.availableCount ?? null,
        ev.propertyCount ?? null,
        ev.country ?? null,
        ev.lang ?? null,
      )
      .run();
  } catch (err) {
    console.error("collection analytics: failed to log event", err);
  }
}

/** Fire-and-forget wrapper: logs without delaying the response. The write is
 *  kept alive past the response via waitUntil (falling back to a floating
 *  promise outside a request context, e.g. dev). */
export function queueCollectionEvent(ev: CollectionEvent): void {
  const work = logCollectionEvent(ev);
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** Cron housekeeping: drop events older than the longest dashboard window (plus
 *  slack) so the table stays bounded. */
export async function pruneCollectionEvents(maxAgeDays = 400): Promise<void> {
  await ensureSchema();
  await db()
    .prepare(`DELETE FROM collection_event WHERE ts < ?`)
    .bind(Date.now() - maxAgeDays * 86_400_000)
    .run();
}

// ---------------------------------------------------------------------------
// Aggregations for the admin dashboard. All scoped to a collection slug + a
// trailing window in days, all plain GROUP BYs over the one table.

export interface CollectionAnalytics {
  totals: {
    /** Landing-page views (any type='view' row). */
    views: number;
    /** Views that ran a dated availability search. */
    searches: number;
    /** Click-throughs to a member property. */
    clicks: number;
    avgLeadDays: number | null;
    avgNights: number | null;
    /** Average member stays available across dated views. */
    avgAvailable: number | null;
    countries: number;
  };
  /** Views per calendar day (activity over time). */
  perDay: { day: string; views: number; searches: number }[];
  /** Most-clicked member properties (by property id). */
  topProperties: { propertyId: string; clicks: number }[];
  /** How far ahead visitors search (dated views only). */
  leadBuckets: { bucket: string; searches: number }[];
  /** Length of stay searched (dated views only). */
  losBuckets: { bucket: string; searches: number }[];
  /** Visitor countries by view volume. */
  countries: { country: string; views: number }[];
}

export async function getCollectionAnalytics(slug: string, days: number): Promise<CollectionAnalytics> {
  await ensureSchema();
  const since = Date.now() - days * 86_400_000;
  const d = db();

  const [totals, perDay, topProperties, leadBuckets, losBuckets, countries] = await d.batch([
    d
      .prepare(
        `SELECT
           SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS views,
           SUM(CASE WHEN event_type = 'view' AND has_dates = 1 THEN 1 ELSE 0 END) AS searches,
           SUM(CASE WHEN event_type = 'click' THEN 1 ELSE 0 END) AS clicks,
           AVG(CASE WHEN event_type = 'view' AND has_dates = 1 THEN lead_days END) AS avg_lead,
           AVG(CASE WHEN event_type = 'view' AND has_dates = 1 THEN nights END) AS avg_nights,
           AVG(CASE WHEN event_type = 'view' AND has_dates = 1 THEN available_count END) AS avg_avail,
           COUNT(DISTINCT CASE WHEN event_type = 'view' THEN country END) AS countries
         FROM collection_event WHERE collection_slug = ? AND ts >= ?`,
      )
      .bind(slug, since),
    d
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch') AS day,
                SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS views,
                SUM(CASE WHEN event_type = 'view' AND has_dates = 1 THEN 1 ELSE 0 END) AS searches
         FROM collection_event WHERE collection_slug = ? AND ts >= ?
         GROUP BY day ORDER BY day`,
      )
      .bind(slug, since),
    d
      .prepare(
        `SELECT property_id AS propertyId, COUNT(*) AS clicks
         FROM collection_event
         WHERE collection_slug = ? AND ts >= ? AND event_type = 'click' AND property_id IS NOT NULL
         GROUP BY property_id ORDER BY clicks DESC, property_id LIMIT 12`,
      )
      .bind(slug, since),
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
         FROM collection_event
         WHERE collection_slug = ? AND ts >= ? AND event_type = 'view' AND has_dates = 1
         GROUP BY bucket ORDER BY ord`,
      )
      .bind(slug, since),
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
         FROM collection_event
         WHERE collection_slug = ? AND ts >= ? AND event_type = 'view' AND has_dates = 1
         GROUP BY bucket ORDER BY ord`,
      )
      .bind(slug, since),
    d
      .prepare(
        `SELECT COALESCE(country, '??') AS country, COUNT(*) AS views
         FROM collection_event
         WHERE collection_slug = ? AND ts >= ? AND event_type = 'view'
         GROUP BY country ORDER BY views DESC LIMIT 12`,
      )
      .bind(slug, since),
  ]);

  const t = (totals.results[0] ?? {}) as Record<string, number | null>;

  return {
    totals: {
      views: Number(t.views ?? 0),
      searches: Number(t.searches ?? 0),
      clicks: Number(t.clicks ?? 0),
      avgLeadDays: t.avg_lead == null ? null : Math.round(Number(t.avg_lead)),
      avgNights: t.avg_nights == null ? null : Math.round(Number(t.avg_nights) * 10) / 10,
      avgAvailable: t.avg_avail == null ? null : Math.round(Number(t.avg_avail) * 10) / 10,
      countries: Number(t.countries ?? 0),
    },
    perDay: perDay.results as CollectionAnalytics["perDay"],
    topProperties: topProperties.results as CollectionAnalytics["topProperties"],
    leadBuckets: (leadBuckets.results as ({ bucket: string; searches: number } & { ord: number })[]).map(
      ({ bucket, searches }) => ({ bucket, searches }),
    ),
    losBuckets: (losBuckets.results as ({ bucket: string; searches: number } & { ord: number })[]).map(
      ({ bucket, searches }) => ({ bucket, searches }),
    ),
    countries: countries.results as CollectionAnalytics["countries"],
  };
}
