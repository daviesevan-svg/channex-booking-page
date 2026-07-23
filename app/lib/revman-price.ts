// Price suggestions — pure, client-safe rules. Not from the reference (it
// never built pricing); a deliberately simple v1 that combines the two demand
// signals we already compute per date:
//
// - the sales-pace score (how the date sells vs last year, DBA-weighted), and
// - the forecast occupancy (where the date is expected to end up),
//
// into a percentage nudge on the date's current prices. Suggestions are
// advisory: nothing changes until the hotelier clicks Apply, and applied
// prices are clamped to per-property min/max guards.

import type { SalesScore } from "./revman-pace";

export interface PriceGuards {
  /** Major currency units. Both must be set before Apply is enabled. */
  minPrice?: number;
  maxPrice?: number;
}

export interface SuggestionInput {
  date: string;
  score: SalesScore;
  forecastPercent: number;
  /** Days before arrival (from today). */
  dba: number;
  /** TOTAL on-the-books occupancy 0..1 — online nights PLUS inferred offline
   *  demand. The pace score only sees online sales, so without this a date
   *  that's nearly sold out offline would still look "needs attention". */
  totalOnBooksPct: number;
}

export interface Suggestion {
  date: string;
  /** Percentage nudge, e.g. 10 = +10%. 0 = leave as is. */
  pct: number;
  reasonKey:
    | "revSugReasonHot"
    | "revSugReasonHigh"
    | "revSugReasonFilling"
    | "revSugReasonSlowNear"
    | "revSugReasonColdNear"
    | "revSugReasonColdMid"
    | "revSugReasonFullHold"
    | "revSugReasonHold";
}

/** Discounts are suppressed once total on-the-books occupancy (online +
 *  inferred offline) reaches this level — the date isn't cold, we just can't
 *  see its bookings. */
export const DISCOUNT_OCC_CEILING = 0.7;

/** Rule table, evaluated top-down. Demand pushing above capacity earns the
 *  biggest lift; weak pace only discounts when the date is close enough that
 *  price is the remaining lever — and never when the date is already mostly
 *  consumed offline. */
export function suggestFor(s: SuggestionInput): Suggestion {
  const { score, forecastPercent: fc, dba } = s;
  if (score === "high_demand" && fc >= 0.8) return { date: s.date, pct: 15, reasonKey: "revSugReasonHot" };
  if (score === "high_demand") return { date: s.date, pct: 10, reasonKey: "revSugReasonHigh" };
  if (score === "steady_sales" && fc >= 0.85) return { date: s.date, pct: 5, reasonKey: "revSugReasonFilling" };
  const wantsDiscount =
    (score === "needs_attention" && dba >= 0 && dba <= 30) ||
    (score === "slow_sales" && fc < 0.4 && dba >= 0 && dba <= 14);
  if (wantsDiscount && s.totalOnBooksPct >= DISCOUNT_OCC_CEILING)
    return { date: s.date, pct: 0, reasonKey: "revSugReasonFullHold" };
  if (score === "needs_attention" && dba >= 0 && dba <= 14)
    return { date: s.date, pct: -10, reasonKey: "revSugReasonColdNear" };
  if (score === "needs_attention" && dba > 14 && dba <= 30)
    return { date: s.date, pct: -5, reasonKey: "revSugReasonColdMid" };
  if (score === "slow_sales" && fc < 0.4 && dba >= 0 && dba <= 14)
    return { date: s.date, pct: -5, reasonKey: "revSugReasonSlowNear" };
  return { date: s.date, pct: 0, reasonKey: "revSugReasonHold" };
}

/** New price for one cell: percentage nudge, rounded to whole units, clamped
 *  to the guards. Returns undefined when the result wouldn't change anything. */
export function applyNudge(current: number, pct: number, guards: Required<PriceGuards>): number | undefined {
  if (pct === 0 || current <= 0) return undefined;
  let next = Math.round(current * (1 + pct / 100));
  next = Math.min(guards.maxPrice, Math.max(guards.minPrice, next));
  return next === current ? undefined : next;
}

export function guardsReady(g: PriceGuards): g is Required<PriceGuards> {
  return (
    typeof g.minPrice === "number" &&
    typeof g.maxPrice === "number" &&
    g.minPrice > 0 &&
    g.maxPrice >= g.minPrice
  );
}
