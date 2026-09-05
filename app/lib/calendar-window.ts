// How much of the availability calendar is loaded, and when to load more.
//
// The date picker shows two months at a time and pages up to a year out, but
// the loaders used to fetch the whole thirteen-month horizon before rendering —
// on a 20-room property that is six figures of D1 rows for a page whose visible
// calendar needs a few thousand. The window below is what actually gets read up
// front; the rest arrives as the guest pages forward.
//
// The half that matters for correctness is what "not loaded yet" means. The
// picker treats any date NOT in `closed` as available, so a shorter read alone
// would silently offer every unloaded date as bookable. Hence `loadedThrough`,
// which travels beside the data everywhere it goes: a date past it is unknown,
// and unknown is never selectable — see useDateRange.
import { addDays, addMonths, format, parseISO, startOfMonth } from "date-fns";

import type { ClosedDates } from "./channex/types";

/** Months loaded before the page renders. The picker shows two; the third is
 *  headroom so the first page-forward, and the min-stay walk off the end of
 *  month two, don't both land on an unloaded date. */
export const CALENDAR_INITIAL_MONTHS = 3;

/** Months added per extension, as the guest pages forward. */
export const CALENDAR_EXTEND_MONTHS = 3;

/** The furthest out the picker can page (MAX_OFFSET in use-date-range, plus the
 *  second visible month). Nothing is ever read or requested beyond this. */
export const CALENDAR_HORIZON_MONTHS = 13;

const iso = (d: Date) => format(d, "yyyy-MM-dd");

/** Last date of the horizon, from a start date. */
export function calendarHorizonEnd(from: string): string {
  return iso(addMonths(parseISO(from), CALENDAR_HORIZON_MONTHS));
}

/** The initial window to read for a calendar starting at `from`, clamped to the
 *  horizon. */
export function initialCalendarWindow(from: string): { from: string; to: string } {
  return { from, to: iso(addMonths(parseISO(from), CALENDAR_INITIAL_MONTHS)) };
}

/** Extend a loaded window to cover `needThrough`, in whole chunks and never
 *  past the horizon. Returns null when it already covers it (or can't grow). */
export function nextCalendarWindow(
  loadedThrough: string,
  needThrough: string,
  horizonEnd: string,
): { from: string; to: string } | null {
  if (loadedThrough >= needThrough || loadedThrough >= horizonEnd) return null;
  let to = loadedThrough;
  while (to < needThrough) to = iso(addMonths(parseISO(to), CALENDAR_EXTEND_MONTHS));
  return { from: iso(addDays(parseISO(loadedThrough), 1)), to: to > horizonEnd ? horizonEnd : to };
}

/** One chunk further on, never past the horizon. Null at the horizon. */
export function extendCalendarWindow(loadedThrough: string, horizonEnd: string): { from: string; to: string } | null {
  return nextCalendarWindow(loadedThrough, iso(addDays(parseISO(loadedThrough), 1)), horizonEnd);
}

/** The last date the picker can display while showing `monthOffset` and the
 *  month after it — i.e. how far availability has to be known for that view to
 *  be fully answerable. */
export function monthViewEnd(today: Date, monthOffset: number): string {
  // The two visible months, then the end of the second one.
  return iso(addDays(startOfMonth(addMonths(startOfMonth(today), monthOffset + 2)), -1));
}

/** Fold a newly loaded slice into what's already known. Both halves are
 *  disjoint by date, so this is a concatenation — but it must stay a NEW object,
 *  because the picker memoises its lookup sets on identity. */
export function mergeClosedDates(a: ClosedDates, b: ClosedDates): ClosedDates {
  return {
    closed: [...a.closed, ...b.closed],
    closedToArrival: [...a.closedToArrival, ...b.closedToArrival],
    closedToDeparture: [...a.closedToDeparture, ...b.closedToDeparture],
    minStayArrival: { ...a.minStayArrival, ...b.minStayArrival },
    minStayThrough: { ...a.minStayThrough, ...b.minStayThrough },
  };
}
