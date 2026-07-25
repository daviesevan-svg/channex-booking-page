// "You're cheaper booking direct" — the decision rules behind the price badge on
// the room card. Pure, and deliberately strict.
//
// The badge makes a factual claim to a guest about a third party's price, so
// every rule here exists to keep that claim true. It fails CLOSED: any doubt and
// the badge simply doesn't render. The hotel loses a nudge; it does not publish a
// saving that isn't there.
//
// What we compare is a captured, anonymous, public Booking.com price for the same
// room type and the same stay against our own all-in direct total. Both sides are
// "the cheapest way to book this room here", which is what the card's own
// "from …" price already shows.
//
// Where it stays silent, and why:
//   - no capture for the check-in date, or Booking wouldn't sell that many nights
//   - the capture is older than the property's freshness limit
//   - the two prices aren't in the same currency (there is no conversion here)
//   - Booking's price isn't tax-inclusive, so it isn't comparable to our all-in
//   - we are not actually cheaper, or only cheaper by less than the threshold

/** Booking-side figures for one room type and one stay, as captured. */
export interface OtaQuote {
  /** Booking's total for the whole stay, or null when it wouldn't sell it. */
  totalMinor: number | null;
  currency: string;
  /** Booking says the price includes taxes and charges. */
  allIncluded: boolean;
  /** e.g. "breakfast" — disclosed to the guest, since it changes what they get. */
  mealPlan: string | null;
  refundable: boolean;
  capturedAt: string;
}

export interface CompareInput {
  /** Our all-in total for the same stay, in minor units. */
  directTotalMinor: number;
  currency: string;
  ota: OtaQuote | null;
  nowMs: number;
  /** Don't claim a saving smaller than this, in whole percent. */
  minSavingPct: number;
  /** Ignore captures older than this. */
  maxAgeHours: number;
}

export type CompareSkip =
  | "no_capture"
  | "stay_not_sold"
  | "stale"
  | "currency_mismatch"
  | "not_all_in"
  | "not_cheaper"
  | "below_threshold";

export interface CompareShown {
  show: true;
  otaTotalMinor: number;
  savingMinor: number;
  /** Whole percent, rounded DOWN — a claim is never rounded up. */
  savingPct: number;
  mealPlan: string | null;
  refundable: boolean;
  capturedAt: string;
}

export type CompareResult = CompareShown | { show: false; skip: CompareSkip };

export const DEFAULT_MIN_SAVING_PCT = 2;
export const DEFAULT_MAX_AGE_HOURS = 48;

const HOUR = 3_600_000;

export function compareDirect(input: CompareInput): CompareResult {
  const { ota, directTotalMinor, currency, nowMs, minSavingPct, maxAgeHours } = input;
  if (!ota) return { show: false, skip: "no_capture" };
  if (ota.totalMinor === null || !(ota.totalMinor > 0)) return { show: false, skip: "stay_not_sold" };
  if (!(directTotalMinor > 0)) return { show: false, skip: "not_cheaper" };

  const capturedMs = Date.parse(ota.capturedAt);
  if (!Number.isFinite(capturedMs) || nowMs - capturedMs > maxAgeHours * HOUR) {
    return { show: false, skip: "stale" };
  }
  // Comparing across currencies would need a conversion we don't do, and getting
  // it wrong would misstate the saving.
  if (ota.currency.toUpperCase() !== currency.toUpperCase()) return { show: false, skip: "currency_mismatch" };
  // Our headline is tax- and fee-inclusive. If Booking's isn't, the guest would
  // be shown a comparison against a number that grows at their checkout.
  if (!ota.allIncluded) return { show: false, skip: "not_all_in" };

  const savingMinor = ota.totalMinor - directTotalMinor;
  if (savingMinor <= 0) return { show: false, skip: "not_cheaper" };
  const savingPct = Math.floor((savingMinor / ota.totalMinor) * 100);
  if (savingPct < Math.max(1, minSavingPct)) return { show: false, skip: "below_threshold" };

  return {
    show: true,
    otaTotalMinor: ota.totalMinor,
    savingMinor,
    savingPct,
    mealPlan: ota.mealPlan,
    refundable: ota.refundable,
    capturedAt: ota.capturedAt,
  };
}

/** What the room card needs — the verdict, already reduced for the client so no
 *  capture internals travel to the page. */
export interface DirectCompareBadge {
  /** Booking's price per night, minor units, for the same stay. */
  otaPerNightMinor: number;
  savingPct: number;
  savingMinor: number;
  /** Set when Booking's cheapest rate includes a meal ours may not. */
  otaMealPlan: string | null;
  otaRefundable: boolean;
  capturedAt: string;
}

export function toBadge(result: CompareResult, nights: number): DirectCompareBadge | null {
  if (!result.show || nights < 1) return null;
  return {
    otaPerNightMinor: Math.round(result.otaTotalMinor / nights),
    savingPct: result.savingPct,
    savingMinor: result.savingMinor,
    otaMealPlan: result.mealPlan,
    otaRefundable: result.refundable,
    capturedAt: result.capturedAt,
  };
}

// ---------------------------------------------------------------------------
// Matching our room types to Booking's.

/** Normalised words of a room name, for suggesting a mapping. */
function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && w !== "room" && w !== "the");
}

/** Similarity of two room names, 0..1 — shared words over the words in either.
 *  Scoring over the UNION rather than the smaller set matters: it makes "Deluxe
 *  Double" a weaker match for "Double Room" than "Double Room" itself is, so an
 *  upgraded room type can't shadow the plain one. Used only to PRE-SELECT a
 *  mapping for the owner to confirm; nothing auto-applies, because mapping the
 *  wrong room would compare against the wrong price. */
export function nameSimilarity(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** Best-guess Booking room for each of our rooms. Each Booking room is used at
 *  most once (two of our room types pointing at one Booking room would compare
 *  both against the same price), strongest match first. */
export function suggestRoomMap(
  ours: { id: string; title: string }[],
  theirs: { roomRef: string; name: string }[],
  threshold = 0.5,
): Record<string, string> {
  const pairs: { ourId: string; roomRef: string; score: number }[] = [];
  for (const o of ours) {
    for (const t of theirs) {
      const score = nameSimilarity(o.title, t.name);
      if (score >= threshold) pairs.push({ ourId: o.id, roomRef: t.roomRef, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.ourId.localeCompare(b.ourId));
  const map: Record<string, string> = {};
  const takenRefs = new Set<string>();
  for (const p of pairs) {
    if (map[p.ourId] || takenRefs.has(p.roomRef)) continue;
    map[p.ourId] = p.roomRef;
    takenRefs.add(p.roomRef);
  }
  return map;
}
