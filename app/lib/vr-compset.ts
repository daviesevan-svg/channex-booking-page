// Vacation-rental competitor set — pure, client-safe ranking. The hotel comp
// set (see revman-compset.ts) ranks purely on review quality, because an OTA
// shopper mostly trades price against guest score. A short-term rental adds a
// second axis the hotel model doesn't have: WHAT the unit is. A studio flat and
// a six-bed farmhouse in the same town aren't substitutes at any price, so a
// useful comp must be the same KIND of place first, then ranked on quality.
//
// So this module carries a normalised place type + an entire-place/private-room
// class alongside a Bayesian-adjusted Airbnb review score (0–5). Membership is
// gated on type similarity (the host confirms the set); within the set we rank
// on quality, exactly like hotels.

/** Whole place vs a room within a shared/hosted property — the coarsest and
 *  most important comparability split (a private room is never a substitute for
 *  an entire home). */
export type PlaceClass = "entire" | "private";

export interface VrUnit {
  id: string;
  name: string;
  isSelf: boolean;
  /** Normalised place type, e.g. "cottage", "flat", "room" (lowercase, from the
   *  Airbnb card title). Undefined when unknown. */
  placeType?: string;
  placeClass?: PlaceClass;
  /** Airbnb guest rating 0–5, optional (unrated units sort last). */
  reviewScore?: number;
  reviewCount?: number;
  /** Airbnb room id / listing URL — carried for the later per-night price feed. */
  airbnbRef?: string;
}

export interface RankedVrUnit extends VrUnit {
  /** Bayesian-adjusted review score 0–5 (2 dp); null when unrated. */
  qualityIndex: number | null;
  /** 1-based rank among rated units; null when unrated. */
  rank: number | null;
  /** 0..1 similarity to the self unit's type (1 = same type, 0.5 = same class,
   *  0 = different class); null when either side's type is unknown or there is
   *  no self unit to compare against. */
  typeMatch: number | null;
}

/** Prior strength for the Bayesian shrink — how many reviews' worth of pull
 *  toward the baseline a unit's own score is weighed against. Airbnb listings
 *  routinely show 5.0 off a handful of stays, so a modest weight still lets an
 *  established 4.9/200 outrank a thin 5.0/4. */
export const VR_QUALITY_PRIOR_WEIGHT = 15;

/** Neutral baseline the prior pulls toward. Airbnb ratings are heavily skewed
 *  high (the vast majority sit 4.6–5.0), so the "average" anchor is ~4.6, not
 *  the 2.5 midpoint of the 0–5 scale — otherwise every thin listing would be
 *  dragged implausibly low. */
export const VR_QUALITY_PRIOR_SCORE = 4.6;

/** Leading title words Airbnb uses for a room WITHIN a property (as opposed to
 *  a whole place). Everything else is treated as an entire place. */
const PRIVATE_TYPES = new Set(["room", "private room", "shared room", "guest suite"]);

/** Normalise an Airbnb card title ("Cottage in Carmarthenshire",
 *  "Room in Tanerdy") into a place type + class. Returns undefined type when
 *  the title doesn't follow the "<Type> in <Location>" shape. */
export function classifyPlace(title: string | undefined): { placeType?: string; placeClass?: PlaceClass } {
  if (!title) return {};
  // The type is everything before the first " in " separator.
  const head = title.split(/\s+in\s+/i)[0]?.trim().toLowerCase();
  if (!head) return {};
  const placeClass: PlaceClass = PRIVATE_TYPES.has(head) ? "private" : "entire";
  return { placeType: head, placeClass };
}

const rated = (u: VrUnit): boolean =>
  typeof u.reviewScore === "number" && u.reviewScore > 0 && (u.reviewCount ?? 0) > 0;

/** Type similarity of a comp to the self unit: 1 same type, 0.5 same class,
 *  0 different class. Null when either type is unknown. */
export function typeSimilarity(self: VrUnit | undefined, comp: VrUnit): number | null {
  if (!self || !self.placeClass || !comp.placeClass) return null;
  if (self.placeType && comp.placeType && self.placeType === comp.placeType) return 1;
  return self.placeClass === comp.placeClass ? 0.5 : 0;
}

/** Ranks the set by Bayesian-adjusted review score, descending, and annotates
 *  each unit's type similarity to the self unit. Unrated units keep a null rank
 *  and sort last by name. Ties break on review volume, then name. Ranking is
 *  quality-only (matching gates membership, not order) so the host reads the
 *  set as "these same-type places, best-reviewed first". */
export function rankVrSet(units: VrUnit[]): RankedVrUnit[] {
  const self = units.find((u) => u.isSelf);
  const withIndex: RankedVrUnit[] = units.map((u) => {
    const typeMatch = u.isSelf ? null : typeSimilarity(self, u);
    if (!rated(u)) return { ...u, qualityIndex: null, rank: null, typeMatch };
    const n = u.reviewCount as number;
    const adj = (n * (u.reviewScore as number) + VR_QUALITY_PRIOR_WEIGHT * VR_QUALITY_PRIOR_SCORE) / (n + VR_QUALITY_PRIOR_WEIGHT);
    return { ...u, qualityIndex: Math.round(adj * 100) / 100, rank: null, typeMatch };
  });

  const sorted = withIndex.sort((a, b) => {
    const ar = a.qualityIndex, br = b.qualityIndex;
    if (ar === null && br === null) return a.name.localeCompare(b.name);
    if (ar === null) return 1;
    if (br === null) return -1;
    if (br !== ar) return br - ar;
    if ((b.reviewCount ?? 0) !== (a.reviewCount ?? 0)) return (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
    return a.name.localeCompare(b.name);
  });

  let rank = 0;
  for (const u of sorted) if (u.qualityIndex !== null) u.rank = ++rank;
  return sorted;
}

/** Our unit's rank and the size of the rated field — for the "you sit #3 of 7
 *  on guest rating among comparable places" headline. */
export function vrSelfStanding(ranked: RankedVrUnit[]): { position: number | null; rated: number } {
  const rankedCount = ranked.filter((u) => u.rank !== null).length;
  const self = ranked.find((u) => u.isSelf);
  return { position: self?.rank ?? null, rated: rankedCount };
}
