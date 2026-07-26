// Is a property actually trading? Used when a collection operator browses the
// directory, so a dormant listing doesn't get added to a destination page and
// sit there showing "no availability" to every guest who clicks it.
//
// Two separate signals, because they answer different questions:
//
//   openPct   — how much of the coming year has rooms for sale. A LOW number is
//               not a fault: a Greek island hotel closed from November to March
//               is seasonal, not dead, and a destination collection wants it.
//   lastAriAt — when the channel manager last pushed anything. THIS is the real
//               "is anyone home" signal. Stale availability can look healthy
//               long after a hotel has stopped maintaining it.
//
// So the rule is: report both, and only flag the two unambiguous problems —
// never connected, and nobody has touched it in months. Don't editorialise
// about a low percentage.

export interface PropertyActivity {
  propertyId: string;
  /** Days in the window with at least one room bookable. */
  openDays: number;
  windowDays: number;
  /** Whole percent of the window that is open, rounded down. */
  openPct: number;
  /** False when the property has never received ARI at all — which is a
   *  different thing from "0% open" and must not be shown as one. */
  hasAri: boolean;
  /** Epoch ms of the last ARI push; null if never. */
  lastAriAt: number | null;
}

/** No ARI push in this long and the listing is presumed unmaintained. Generous
 *  on purpose: a small hotel that sets a year of availability in one go and
 *  then leaves it alone is normal, and wrongly branding it inactive in front of
 *  another hotelier is worse than missing a genuinely dead one. */
export const STALE_AFTER_DAYS = 120;

export type ActivityLevel = "unknown" | "stale" | "ok";

export function activityLevel(a: PropertyActivity, nowMs: number): ActivityLevel {
  if (!a.hasAri) return "unknown";
  if (a.lastAriAt === null) return "stale";
  return nowMs - a.lastAriAt > STALE_AFTER_DAYS * 86_400_000 ? "stale" : "ok";
}

export function openPercent(openDays: number, windowDays: number): number {
  if (!(windowDays > 0) || !(openDays > 0)) return 0;
  return Math.floor((Math.min(openDays, windowDays) / windowDays) * 100);
}
