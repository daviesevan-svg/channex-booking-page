// Price suggestions — pure, client-safe rules. Not from the reference (it
// never built pricing); a deliberately simple v1 that combines the two demand
// signals we already compute per date:
//
// - the sales-pace score (how the date sells vs last year, DBA-weighted), and
// - the forecast occupancy (where the date is expected to end up),
//
// into a percentage nudge on the date's current prices, modulated by a third
// signal when Rate Intelligence has captured it: where our own Booking.com
// price sits against the comp set's median that night. Suggestions are
// advisory: nothing changes until the hotelier clicks Apply, and applied
// prices are clamped to per-property min/max guards.

import type { SalesScore } from "./revman-pace";

export interface PriceGuards {
  /** Major currency units. Both must be set before Apply is enabled. */
  minPrice?: number;
  maxPrice?: number;
}

/** Where our price sits against the comp set for one date, from Rate
 *  Intelligence captures. Both sides are the same measure — cheapest 1-night
 *  price on each hotel's own Booking.com page — so OTA-side discounts wash
 *  out of the ratio. */
export interface CompSignal {
  /** Own captured price ÷ comp-set median (same currency). 0.9 = priced 10%
   *  below the market that night. */
  index: number;
  /** Own price at or below EVERY captured comp price that night. */
  cheapest: boolean;
}

/** Comp prices needed before the signal activates — a median of one or two
 *  hotels is too noisy to move prices on. */
export const COMP_MIN_SAMPLE = 3;
/** Priced at or below this share of the comp median counts as below market. */
export const COMP_BELOW_MARKET = 0.9;
/** Priced at or above this share of the comp median counts as above market
 *  (wider than the below-market band: raising into a premium position is the
 *  riskier move, so it takes a clearer gap to temper a raise). */
export const COMP_ABOVE_MARKET = 1.15;
/** How much the comp position adds to / shaves off a demand-driven raise. */
export const COMP_NUDGE = 5;

/** Comp position for one date, or undefined when the signal shouldn't
 *  activate: own price missing, or fewer than COMP_MIN_SAMPLE comp prices.
 *  Prices are minor units, pre-filtered to one currency by the caller. */
export function compSignalFor(ownMinor: number | null | undefined, compMinors: number[]): CompSignal | undefined {
  if (typeof ownMinor !== "number" || ownMinor <= 0) return undefined;
  const comps = compMinors.filter((p) => p > 0);
  if (comps.length < COMP_MIN_SAMPLE) return undefined;
  const median = medianOf(comps);
  return { index: ownMinor / median, cheapest: ownMinor <= Math.min(...comps) };
}

export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
  /** Market position from Rate Intelligence; absent (no capture, stale, too
   *  few comps) leaves the demand-only rules untouched. */
  comp?: CompSignal;
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
    | "revSugReasonSoldOut"
    | "revSugReasonHold"
    | "revSugReasonBelowMarket"
    | "revSugReasonAboveMarket"
    | "revSugReasonCheapestHold";
}

/** Discounts are suppressed once total on-the-books occupancy (online +
 *  inferred offline) OR the forecast reaches this level — the date either
 *  isn't cold (we just can't see its bookings) or is expected to fill
 *  anyway. */
export const DISCOUNT_OCC_CEILING = 0.7;

/** Rule table, evaluated top-down, then modulated by market position. Demand
 *  pushing above capacity earns the biggest lift; weak pace only discounts
 *  when the date is close enough that price is the remaining lever — and
 *  never when the date is already mostly consumed offline. */
export function suggestFor(s: SuggestionInput): Suggestion {
  return applyCompSignal(demandSuggestion(s), s.comp);
}

/** Market-position modulation, applied AFTER the demand rules so it only ever
 *  adjusts a nudge the demand signals already justify — it never invents one:
 *  - raising while priced below market: the comps confirm the market bears
 *    more, so raise harder;
 *  - raising while already well above market: keep the direction, temper the
 *    size (never below the demand floor of "hold");
 *  - discounting while ALREADY the cheapest in the set: price isn't why the
 *    date is slow — hold instead of racing the market down. */
function applyCompSignal(s: Suggestion, comp?: CompSignal): Suggestion {
  if (!comp) return s;
  if (s.pct > 0 && comp.index <= COMP_BELOW_MARKET)
    return { ...s, pct: s.pct + COMP_NUDGE, reasonKey: "revSugReasonBelowMarket" };
  if (s.pct > 0 && comp.index >= COMP_ABOVE_MARKET)
    return { ...s, pct: Math.max(0, s.pct - COMP_NUDGE), reasonKey: "revSugReasonAboveMarket" };
  if (s.pct < 0 && comp.cheapest) return { ...s, pct: 0, reasonKey: "revSugReasonCheapestHold" };
  return s;
}

function demandSuggestion(s: SuggestionInput): Suggestion {
  const { score, forecastPercent: fc, dba } = s;
  // Sold out (incl. offline): nothing left to price. Conservative hold — a
  // cancellation re-sells at the current rate.
  if (score === "sold_out") return { date: s.date, pct: 0, reasonKey: "revSugReasonSoldOut" };
  // Filling up: online pace is behind, but the date is (nearly) full or
  // forecast to fill — hold rather than discount.
  if (score === "filling_up") return { date: s.date, pct: 0, reasonKey: "revSugReasonFullHold" };
  if (score === "high_demand" && fc >= 0.8) return { date: s.date, pct: 15, reasonKey: "revSugReasonHot" };
  if (score === "high_demand") return { date: s.date, pct: 10, reasonKey: "revSugReasonHigh" };
  if (score === "steady_sales" && fc >= 0.85) return { date: s.date, pct: 5, reasonKey: "revSugReasonFilling" };
  const wantsDiscount =
    (score === "needs_attention" && dba >= 0 && dba <= 30) ||
    (score === "slow_sales" && fc < 0.4 && dba >= 0 && dba <= 14);
  if (wantsDiscount && (s.totalOnBooksPct >= DISCOUNT_OCC_CEILING || fc >= DISCOUNT_OCC_CEILING))
    return { date: s.date, pct: 0, reasonKey: "revSugReasonFullHold" };
  if (score === "needs_attention" && dba >= 0 && dba <= 14)
    return { date: s.date, pct: -10, reasonKey: "revSugReasonColdNear" };
  if (score === "needs_attention" && dba > 14 && dba <= 30)
    return { date: s.date, pct: -5, reasonKey: "revSugReasonColdMid" };
  if (score === "slow_sales" && fc < 0.4 && dba >= 0 && dba <= 14)
    return { date: s.date, pct: -5, reasonKey: "revSugReasonSlowNear" };
  return { date: s.date, pct: 0, reasonKey: "revSugReasonHold" };
}

/** Target price for one cell: the cell's BASE price (what it was before
 *  revenue management ever touched it — never the current, possibly already
 *  nudged price, so re-applying can't compound) scaled by the date's demand
 *  percentage, rounded to whole units and clamped to the guards. */
export function targetPrice(base: number, pct: number, guards: Required<PriceGuards>): number {
  const next = Math.round(base * (1 + pct / 100));
  return Math.min(guards.maxPrice, Math.max(guards.minPrice, next));
}

export function guardsReady(g: PriceGuards): g is Required<PriceGuards> {
  return (
    typeof g.minPrice === "number" &&
    typeof g.maxPrice === "number" &&
    g.minPrice > 0 &&
    g.maxPrice >= g.minPrice
  );
}
