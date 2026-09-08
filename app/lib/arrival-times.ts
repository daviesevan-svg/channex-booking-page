// The "estimated arrival" choices offered at checkout.
//
// Channex validates arrival_hour as strict HH:MM, so the guest picks from a
// list rather than typing. The list used to be every half hour of the day for
// every property, which let a guest at a hotel with a 15:00–18:00 reception
// window self-select 02:00 — the hotel found out from the PMS. A property that
// sets a LATEST check-in (SiteSettings.checkinUntil) now gets the list clipped
// to its window; one that hasn't keeps the full day, exactly as before, so the
// change is opt-in per property.

import { parseHHMM } from "./dates";

const DAY_HALF_HOURS = 48;

/** "HH:MM" for half-hour slot `i` of the day (0 → 00:00, 47 → 23:30). */
const slot = (i: number) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`;

/** Round minutes-since-midnight to the half-hour slot index, up or down. */
const slotIndex = (minutes: number, round: "up" | "down") =>
  round === "up" ? Math.ceil(minutes / 30) : Math.floor(minutes / 30);

/**
 * Half-hour arrival times for a property.
 *
 *  - No `until`: the whole day (48 entries). Unchanged behaviour.
 *  - `until` set: from `from` (default 15:00) to `until` inclusive, both rounded
 *    inward to half hours. An `until` at or before `from` — a typo — falls back
 *    to the whole day rather than to an empty list: a guest must always be able
 *    to answer the question.
 */
export function arrivalTimes(window: { from?: string | null; until?: string | null } = {}): string[] {
  const untilMin = window.until ? parseHHMM(window.until) : null;
  if (untilMin == null) return Array.from({ length: DAY_HALF_HOURS }, (_, i) => slot(i));
  const fromMin = (window.from ? parseHHMM(window.from) : null) ?? 15 * 60;
  const first = slotIndex(fromMin, "up");
  const last = Math.min(DAY_HALF_HOURS - 1, slotIndex(untilMin, "down"));
  if (last < first) return Array.from({ length: DAY_HALF_HOURS }, (_, i) => slot(i));
  return Array.from({ length: last - first + 1 }, (_, i) => slot(first + i));
}
