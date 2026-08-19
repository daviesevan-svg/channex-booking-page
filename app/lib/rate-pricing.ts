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
  /** Children are priced exactly like adults: they count into the occupancy
   *  used for pricing (per-occupancy row / extra-adult supplement) and the
   *  age bands are ignored. */
  childrenAsAdults?: boolean;
}

/** The occupancy a party is PRICED at: adults, plus children when the rate
 *  prices children as adults. Capacity/maxAdults checks stay on the real
 *  party split — this is for price lookups only. */
export function pricedOccupancy(
  op: OccupancyPricing | undefined,
  adults: number,
  childrenAge: number[],
): number {
  return adults + (op?.childrenAsAdults ? childrenAge.length : 0);
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
  const priced = pricedOccupancy(op, adults, childrenAge);
  const def = Math.max(1, Math.round(op.defaultOccupancy) || 1);
  let d = 0;
  if (priced > def) d += (priced - def) * (op.extraAdultPrice ?? 0);
  else if (priced < def) d -= (def - priced) * (op.lessGuestDiscount ?? 0);
  return d + childrenNightlyDelta(op, childrenAge);
}

/** The children part of the occupancy delta alone — per child per night, by age
 *  band. This is the only part of `occupancyPricing` a PER-PERSON rate uses:
 *  adult pricing comes from the per-occupancy prices themselves. */
export function childrenNightlyDelta(op: OccupancyPricing | undefined, childrenAge: number[]): number {
  if (!op || op.childrenAsAdults) return 0;
  let d = 0;
  for (const age of childrenAge) {
    if (age <= 3) d += op.child0to3 ?? 0;
    else if (age <= 12) d += op.child4to12 ?? 0;
    else d += op.child13plus ?? 0;
  }
  return d;
}

/** Pick the price for `adults` from a per-occupancy price map (keys = adults,
 *  key 0 = an occupancy-less price — a manual edit, or a leftover from when the
 *  plan was pushed per-room — read as a price PER ADULT).
 *
 *  Selection: a pushed per-occupancy price wins — the exact occupancy, else the
 *  nearest defined below (Channex pushes a contiguous 1..max, so this is just
 *  clamping), else the smallest above. Occupancy-0 is only the fallback:
 *  Channex per-ROOM pushes also land at occupancy 0, so letting it win would
 *  let stale rows shadow a per-person push forever after a rate switches mode.
 *  Undefined when the map has no usable entry. */
export function perPersonPrice(
  byOcc: Record<number, number> | undefined,
  adults: number,
): number | undefined {
  if (!byOcc) return undefined;
  if (byOcc[adults] !== undefined && adults > 0) return byOcc[adults];
  const occs = Object.keys(byOcc)
    .map(Number)
    .filter((o) => o > 0)
    .sort((a, b) => a - b);
  if (occs.length === 0) {
    return byOcc[0] !== undefined ? byOcc[0] * Math.max(1, adults) : undefined;
  }
  const below = occs.filter((o) => o < adults);
  return byOcc[below.length ? below[below.length - 1] : occs[0]];
}
