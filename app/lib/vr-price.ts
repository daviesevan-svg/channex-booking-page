// Price suggestions for a single-unit rental — pure, client-safe rules.
//
// The hotel engine (revman-price.ts) reads its own sales pace from its own
// booking history. A one-unit rental can't: with a single room, "pace" is just
// booked-or-not, and one booking is 100% occupancy. So this engine reads pace
// from the MARKET instead — how fast comparable Airbnb listings are filling for
// each date (see vr-pickup) — and combines it with where our price sits against
// the comp median (see vr-comp-capture's price samples).
//
// Two signals, and the interaction between them is the whole point:
//   market pace   → is demand for this date strong or weak?
//   price position→ do we have room to move, or are we already the cheap option?
// Strong demand while priced below the market is the clearest "raise" there is;
// weak demand while already the cheapest is the clearest "don't discount", since
// price plainly isn't what's holding the date back.
//
// Suggestions are advisory: nothing changes until the host clicks Apply, and
// applied prices are clamped to the property's min/max guards.

export type PaceSignal = "ahead" | "on_track" | "behind" | "unknown";

export interface VrSuggestionInput {
  date: string;
  /** Market pace for the date, from the comp set's fill curve. */
  paceSignal: PaceSignal;
  /** Share of tracked comps already booked, 0..1; null when untracked. */
  marketOccupancy: number | null;
  /** Days before arrival. */
  dba: number;
  /** Our current price for the date (major units); undefined when none loaded. */
  ownPrice?: number;
  /** Median comp price for the date (major units); null when unsampled. */
  marketMedian?: number | null;
  /** Cheapest comp price for the date (major units); null when unsampled. */
  marketCheapest?: number | null;
  /** Our unit is already sold for this date — nothing left to price. */
  ownBooked: boolean;
}

export interface VrSuggestion {
  date: string;
  /** Percentage nudge, e.g. 10 = +10%. 0 = leave as is. */
  pct: number;
  reasonKey:
    | "vrSugReasonBooked"
    | "vrSugReasonHotBelow"
    | "vrSugReasonHot"
    | "vrSugReasonHotAbove"
    | "vrSugReasonTight"
    | "vrSugReasonMarketFull"
    | "vrSugReasonAlreadyCheapest"
    | "vrSugReasonSlowNear"
    | "vrSugReasonSlowMid"
    | "vrSugReasonOverMarket"
    | "vrSugReasonHold";
}

/** Priced this far below the comp median counts as "the cheap option" — room to
 *  push when demand is strong. */
export const BELOW_MARKET_AT = 0.9;
/** Priced this far above the median counts as already premium — temper raises. */
export const ABOVE_MARKET_AT = 1.15;
/** Well above the market: enough to be the reason a soft date isn't selling. */
export const WAY_ABOVE_MARKET_AT = 1.25;
/** Discounts are suppressed once this much of the comp set is booked — the date
 *  isn't actually soft, so cutting price just gives away rate. */
export const DISCOUNT_MARKET_CEILING = 0.7;
/** A market this full is tight even when pace looks merely normal. */
export const TIGHT_MARKET_AT = 0.85;

/** Rule table, evaluated top-down. */
export function suggestVrPrice(s: VrSuggestionInput): VrSuggestion {
  const { date, paceSignal, marketOccupancy: occ, dba } = s;

  // Already sold: a cancellation should re-sell at the current rate.
  if (s.ownBooked) return { date, pct: 0, reasonKey: "vrSugReasonBooked" };

  const index = s.ownPrice && s.marketMedian ? s.ownPrice / s.marketMedian : null;
  // "Cheapest in the set" needs our price AND a sampled floor to compare with.
  const isCheapest = Boolean(s.ownPrice && s.marketCheapest && s.ownPrice <= s.marketCheapest);

  // Market filling faster than comparable dates at the same lead time.
  if (paceSignal === "ahead") {
    if (index !== null && index <= BELOW_MARKET_AT) return { date, pct: 15, reasonKey: "vrSugReasonHotBelow" };
    if (index !== null && index >= ABOVE_MARKET_AT) return { date, pct: 5, reasonKey: "vrSugReasonHotAbove" };
    return { date, pct: 10, reasonKey: "vrSugReasonHot" };
  }

  // Not flagged hot, but the comp set is nearly gone — scarcity is real.
  if (occ !== null && occ >= TIGHT_MARKET_AT && paceSignal !== "behind") {
    return { date, pct: 5, reasonKey: "vrSugReasonTight" };
  }

  if (paceSignal === "behind") {
    // The comp set is still well booked, so weak *relative* pace doesn't mean a
    // soft date — hold rather than discount into demand that exists.
    if (occ !== null && occ >= DISCOUNT_MARKET_CEILING) return { date, pct: 0, reasonKey: "vrSugReasonMarketFull" };
    // The single most valuable rule: if we're already the cheapest comparable
    // place and the date still isn't moving, price is not the constraint. Going
    // lower only erodes rate — this is what stops an automated race to the bottom.
    if (isCheapest) return { date, pct: 0, reasonKey: "vrSugReasonAlreadyCheapest" };
    if (dba >= 0 && dba <= 14) return { date, pct: -10, reasonKey: "vrSugReasonSlowNear" };
    if (dba > 14 && dba <= 30) return { date, pct: -5, reasonKey: "vrSugReasonSlowMid" };
    // Too far out for price to be the lever yet.
    return { date, pct: 0, reasonKey: "vrSugReasonHold" };
  }

  // No usable pace read, but we're priced well above a market that isn't selling
  // and the date is close enough to matter.
  if (
    index !== null &&
    index >= WAY_ABOVE_MARKET_AT &&
    occ !== null &&
    occ <= 0.3 &&
    dba >= 0 &&
    dba <= 21 &&
    !isCheapest
  ) {
    return { date, pct: -5, reasonKey: "vrSugReasonOverMarket" };
  }

  return { date, pct: 0, reasonKey: "vrSugReasonHold" };
}
