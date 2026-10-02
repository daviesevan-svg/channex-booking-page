// Advance-purchase window on a rate plan: how many days before ARRIVAL a stay
// may be booked on it. Early Bird = a minimum ("at least 30 days ahead"), Last
// Minute = a maximum ("only arrivals in the next 3 days"). Client-safe — the
// editor, the booking gate and the calendar all ask the same question here.

export interface AdvanceWindow {
  /** Fewest days between today and arrival. Absent = no floor. */
  minAdvanceDays?: number;
  /** Most days between today and arrival. Absent = no ceiling; 0 = same-day
   *  arrivals only, so a blank box and a zero must stay distinguishable. */
  maxAdvanceDays?: number;
}

export type AdvanceMiss = "min_advance" | "max_advance";

/** Why a rate is not on sale for an arrival `daysAhead` days from today (today =
 *  0), or null when it is. Both bounds are inclusive. */
export function advanceMiss(w: AdvanceWindow, daysAhead: number): AdvanceMiss | null {
  if (w.minAdvanceDays != null && daysAhead < w.minAdvanceDays) return "min_advance";
  if (w.maxAdvanceDays != null && daysAhead > w.maxAdvanceDays) return "max_advance";
  return null;
}

/** An editor/API value → a day count, or undefined for "no limit". Blank is no
 *  limit; 0 is kept (a real value for the maximum). Negative / non-numeric
 *  input is rejected as NaN so the caller can complain instead of guessing. */
export function parseAdvanceDays(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (text === "") return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

/** The window's problem, if any — in the editor and the API alike. */
export function validateAdvanceWindow(w: AdvanceWindow): "min_gt_max" | null {
  return w.minAdvanceDays != null && w.maxAdvanceDays != null && w.minAdvanceDays > w.maxAdvanceDays ? "min_gt_max" : null;
}

/** Whether any of these rates sells inside an advance window. Such a rate's
 *  open/closed state changes with the calendar, not just with edits, so the
 *  Google feed has to be refreshed when the hotel's date rolls over. */
export function hasAdvanceWindow(rates: (AdvanceWindow & { active?: boolean })[]): boolean {
  return rates.some((r) => r.active !== false && (r.minAdvanceDays != null || r.maxAdvanceDays != null));
}
