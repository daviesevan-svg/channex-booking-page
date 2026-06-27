// Client-safe per-person (occupancy) rate pricing: the type + pure math shared
// by the server pricing chokepoint (catalog.server) and the live price preview
// on the room detail page. No server-only imports here.

/** Per-person pricing rules for a rate. The base price (in inventory) covers
 *  `defaultOccupancy` adults; extra adults add, fewer adults discount, and each
 *  child is priced by age band — all per night. Absent = flat pricing. */
export interface OccupancyPricing {
  /** Adults the base/inventory price covers. */
  defaultOccupancy: number;
  /** Added per adult above default occupancy, per night. */
  extraAdultPrice?: number;
  /** Subtracted per adult below default occupancy, per night. */
  lessGuestDiscount?: number;
  /** Per child per night, by age band (0–3, 4–12, 13+). */
  child0to3?: number;
  child4to12?: number;
  child13plus?: number;
}

/** Per-night price adjustment for a party under a rate's occupancy pricing.
 *  Adults above/below the default occupancy add/discount; each child is priced
 *  by age band. Returns 0 when the rate has no occupancy pricing. */
export function occupancyNightlyDelta(
  op: OccupancyPricing | undefined,
  adults: number,
  childrenAge: number[],
): number {
  if (!op) return 0;
  const def = Math.max(1, Math.round(op.defaultOccupancy) || 1);
  let d = 0;
  if (adults > def) d += (adults - def) * (op.extraAdultPrice ?? 0);
  else if (adults < def) d -= (def - adults) * (op.lessGuestDiscount ?? 0);
  for (const age of childrenAge) {
    if (age <= 3) d += op.child0to3 ?? 0;
    else if (age <= 12) d += op.child4to12 ?? 0;
    else d += op.child13plus ?? 0;
  }
  return d;
}
