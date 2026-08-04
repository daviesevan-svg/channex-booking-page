// Server side of the trading signal (see property-activity.ts for what the two
// numbers mean and why a low percentage is not a fault).
//
// Batched deliberately: the directory renders a page of properties at a time,
// and doing this per row would be one query per property. One grouped query
// covers the whole page.
import { ensureSchema, getLastAriReceivedAt } from "./ari.server";
import { getDB } from "./config.server";
import { chunkForBinds, placeholders } from "./d1-limits";
import { openPercent, type PropertyActivity } from "./property-activity";

/** How far ahead we measure. `pruneAri` keeps 730 days of future ARI, so a
 *  365-day window is always fully covered by stored data. */
export const ACTIVITY_WINDOW_DAYS = 365;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Days in [from, to] where at least one room type has units for sale.
 *
 *  Deliberately ignores stop_sell. Closure is expressed either by zeroing
 *  availability or by stop-selling every rate plan of every room, and getting
 *  the second exactly right in SQL is fiddly enough to get wrong. Ignoring it
 *  can only OVERSTATE openness, which errs toward including a property rather
 *  than wrongly branding a live one inactive — the right way to be wrong here. */
async function openDaysFor(ids: string[], from: string, to: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const d = getDB();
  if (!d || ids.length === 0) return out;

  // `reserved: 2` for the two date bounds — a flat chunk of 100 ids plus those
  // would be 102 parameters, two over what D1 accepts.
  for (const batch of chunkForBinds(ids, 2)) {
    const rows = await d
      .prepare(
        `SELECT hotel_code, COUNT(DISTINCT date) AS open_days
           FROM availability
          WHERE hotel_code IN (${placeholders(batch.length)}) AND date >= ? AND date <= ? AND avail > 0
          GROUP BY hotel_code`,
      )
      .bind(...batch, from, to)
      .all<{ hotel_code: string; open_days: number }>();
    for (const r of rows.results ?? []) out.set(r.hotel_code, Number(r.open_days) || 0);
  }
  return out;
}

/** Which of `ids` have ever received ARI. Distinguishes "never connected" from
 *  "connected and fully closed", which look identical in the open-days count. */
async function seenIds(ids: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const d = getDB();
  if (!d || ids.length === 0) return seen;

  // Nothing else is bound here, so the ids get the whole budget.
  for (const batch of chunkForBinds(ids)) {
    for (const table of ["availability", "rate"] as const) {
      const rows = await d
        .prepare(`SELECT DISTINCT hotel_code FROM ${table} WHERE hotel_code IN (${placeholders(batch.length)})`)
        .bind(...batch)
        .all<{ hotel_code: string }>();
      for (const r of rows.results ?? []) seen.add(r.hotel_code);
    }
  }
  return seen;
}

/** Trading signal for a set of properties. Never throws: a failure here must
 *  degrade the directory to "unknown" rather than break the page. */
export async function propertyActivity(
  propertyIds: string[],
  nowMs: number = Date.now(),
): Promise<Map<string, PropertyActivity>> {
  const windowDays = ACTIVITY_WINDOW_DAYS;
  const blank = (propertyId: string): PropertyActivity => ({
    propertyId,
    openDays: 0,
    windowDays,
    openPct: 0,
    hasAri: false,
    lastAriAt: null,
  });
  const out = new Map(propertyIds.map((id) => [id, blank(id)]));
  if (propertyIds.length === 0) return out;

  try {
    await ensureSchema();
    const from = iso(nowMs);
    const to = iso(nowMs + (windowDays - 1) * 86_400_000);
    const [days, seen] = await Promise.all([openDaysFor(propertyIds, from, to), seenIds(propertyIds)]);
    // Last-received lives in KV, one key per property — cheap, but do them
    // together rather than serially down the page.
    const lastSeen = await Promise.all(propertyIds.map((id) => getLastAriReceivedAt(id).catch(() => null)));

    propertyIds.forEach((id, i) => {
      const openDays = days.get(id) ?? 0;
      out.set(id, {
        propertyId: id,
        openDays,
        windowDays,
        openPct: openPercent(openDays, windowDays),
        hasAri: seen.has(id),
        lastAriAt: lastSeen[i],
      });
    });
  } catch (err) {
    console.log(`[activity] failed, reporting unknown: ${err}`);
  }
  return out;
}
