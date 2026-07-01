// Maps Roompanda's automatic offers to Google Promotions. Every enabled auto
// offer becomes a non-combinable promotion so Google lands on the single best
// applicable offer — matching our engine's bestAutoOffer — instead of stacking.
//
// Only auto offers apply: they're percent-only by construction (see
// promotions.ts / offerMatches). Guest-typed codes can't exist on Google and
// stay checkout-only.
import { getPromotions } from "../promotions.server";
import type { PromoEntry } from "./xml";

export async function googlePromotions(pid: string): Promise<PromoEntry[]> {
  const promos = await getPromotions(pid);
  return promos
    .filter((p) => p.trigger === "auto" && p.enabled && p.type === "percent" && p.value > 0)
    .map((p) => {
      const c = p.conditions ?? {};
      return {
        id: p.id,
        percent: p.value,
        minDaysAhead: c.minDaysAhead,
        maxDaysAhead: c.maxDaysAhead,
        minNights: c.minNights,
        stayFrom: c.stayFrom,
        stayTo: c.stayTo,
      };
    });
}
