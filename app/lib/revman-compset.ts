// Competitor set — pure, client-safe ranking. A hotel's competitive position
// is driven mostly by its guest-review score (the strongest predictor of how
// much price an OTA shopper will accept), so the set is ranked on a Bayesian-
// adjusted review score: a prior pulls low-volume scores toward a neutral
// baseline, so a 9.8 with 3 reviews can't outrank a 9.1 with 2,000 (it lands
// ~8.2, below the established 9.1). Star class is
// carried for context and breaks ties but doesn't drive the rank — a
// well-reviewed 3-star genuinely converts above a poorly-reviewed 5-star.
//
// Scores are on a 0–10 scale (what hoteliers read off Booking.com). Our own
// hotel's score is pre-filled from internal direct-booking reviews normalised
// to /10, and is editable — the two populations aren't identical, so the
// hotelier gets the final say.

export interface CompHotel {
  id: string;
  name: string;
  isSelf: boolean;
  /** 1–5, optional. */
  starClass?: number;
  /** Guest-review score 0–10, optional (unrated hotels sort last). */
  reviewScore?: number;
  reviewCount?: number;
  /** Booking.com URL or hotel_id — carried for the later price feed. */
  bookingRef?: string;
}

export interface RankedHotel extends CompHotel {
  /** Bayesian-adjusted review score 0–10 (1 dp); null when unrated. */
  qualityIndex: number | null;
  /** 1-based rank among rated hotels; null when unrated. */
  rank: number | null;
}

/** Prior strength: how many reviews' worth of "pull toward the baseline" a
 *  hotel's own score is weighed against. ~20 keeps a handful of reviews from
 *  dominating without washing out real differences at high volume. */
export const QUALITY_PRIOR_WEIGHT = 20;

/** Neutral baseline the prior pulls toward — roughly an average hotel's OTA
 *  guest score on the 0–10 scale. Fixed rather than the set mean: with only a
 *  handful of hotels the set mean is noisy, and a fixed baseline correctly
 *  penalises thin review counts (a high score with few reviews shrinks toward
 *  "average" until volume proves it). */
export const QUALITY_PRIOR_SCORE = 8.0;

const rated = (h: CompHotel): boolean =>
  typeof h.reviewScore === "number" && h.reviewScore > 0 && (h.reviewCount ?? 0) > 0;

/** Ranks the set by Bayesian-adjusted review score, descending. Unrated hotels
 *  (no score / no reviews) keep a null rank and sort last by name. Ties break
 *  on star class, then review volume, then name — deterministic. */
export function rankCompSet(hotels: CompHotel[]): RankedHotel[] {
  const withIndex = hotels.map((h) => {
    if (!rated(h)) return { ...h, qualityIndex: null as number | null, rank: null as number | null };
    const n = h.reviewCount as number;
    const adj =
      (n * (h.reviewScore as number) + QUALITY_PRIOR_WEIGHT * QUALITY_PRIOR_SCORE) / (n + QUALITY_PRIOR_WEIGHT);
    return { ...h, qualityIndex: Math.round(adj * 10) / 10, rank: null as number | null };
  });

  const sorted = withIndex.sort((a, b) => {
    const ar = a.qualityIndex, br = b.qualityIndex;
    if (ar === null && br === null) return a.name.localeCompare(b.name);
    if (ar === null) return 1;
    if (br === null) return -1;
    if (br !== ar) return br - ar;
    if ((b.starClass ?? 0) !== (a.starClass ?? 0)) return (b.starClass ?? 0) - (a.starClass ?? 0);
    if ((b.reviewCount ?? 0) !== (a.reviewCount ?? 0)) return (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
    return a.name.localeCompare(b.name);
  });

  let rank = 0;
  for (const h of sorted) if (h.qualityIndex !== null) h.rank = ++rank;
  return sorted;
}

/** Our hotel's rank and the size of the rated field — for the "you sit #3 of
 *  7 on guest rating" headline. Returns null position when we're unrated. */
export function selfStanding(ranked: RankedHotel[]): { position: number | null; rated: number } {
  const rankedCount = ranked.filter((h) => h.rank !== null).length;
  const self = ranked.find((h) => h.isSelf);
  return { position: self?.rank ?? null, rated: rankedCount };
}
