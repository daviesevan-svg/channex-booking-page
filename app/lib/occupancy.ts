import type { RatePlan, RoomWithRates } from "./channex/types";

export interface Occupancy {
  adults: number;
  childrenAge: number[];
}

/** Total guests needing a bed (infants not separated by this property's data). */
export function partySize(occ: Occupancy): number {
  return occ.adults + occ.childrenAge.length;
}

/** A room's true capacity, derived from the max occupancy across its rate plans
 *  (Channex exposes no room-level max; rate-plan occupancy is the real ceiling). */
export function roomCapacity(room: RoomWithRates): { maxAdults: number; capacity: number } {
  let maxAdults = 0;
  let capacity = 0;
  for (const rp of room.ratePlans) {
    const o = rp.occupancy;
    maxAdults = Math.max(maxAdults, o.adults);
    capacity = Math.max(capacity, o.adults + o.children + o.infants);
  }
  return { maxAdults, capacity };
}

/** Whether a single room can accommodate the searched party. */
export function roomFits(room: RoomWithRates, occ: Occupancy): boolean {
  const { maxAdults, capacity } = roomCapacity(room);
  return occ.adults <= maxAdults && partySize(occ) <= capacity;
}

/** Rooms of this type available to sell (max across its rate plans, since
 *  virtual rate plans share the room's physical inventory). */
export function roomAvailability(room: RoomWithRates): number {
  const vals = room.ratePlans
    .map((r) => r.availability)
    .filter((n): n is number => typeof n === "number");
  return vals.length ? Math.max(...vals) : Infinity;
}

const rateOccTotal = (r: RatePlan) =>
  r.occupancy.adults + r.occupancy.children + r.occupancy.infants;

/** Channex `withVirtualRatePlans` returns one rate plan per occupancy level.
 *  Collapse them to a single variant per distinct rate product, choosing the
 *  occupancy that best fits the searched party (largest that doesn't exceed it,
 *  else the smallest). This dedupes the UI and prices for the actual party. */
export function ratePlansForParty(room: RoomWithRates, party: number): RatePlan[] {
  const groups = new Map<string, RatePlan[]>();
  for (const rp of room.ratePlans) {
    const key = `${rp.title}|${rp.mealPlan ?? ""}|${rp.cancellationPolicy?.title ?? ""}`;
    const list = groups.get(key);
    if (list) list.push(rp);
    else groups.set(key, [rp]);
  }
  return [...groups.values()].map((variants) => {
    const sorted = [...variants].sort((a, b) => rateOccTotal(a) - rateOccTotal(b));
    const fitting = sorted.filter((r) => rateOccTotal(r) <= Math.max(party, 1));
    return fitting.length ? fitting[fitting.length - 1] : sorted[0];
  });
}

/** Read occupancy from URL search params (adults + comma-separated childrenAge). */
export function readOccupancy(sp: URLSearchParams): Occupancy {
  const adults = Math.max(1, Number(sp.get("adults")) || 2);
  const raw = sp.get("childrenAge") || "";
  const childrenAge = raw
    .split(",")
    .map((s) => parseInt(s, 10))
    .filter((n) => !Number.isNaN(n) && n >= 0);
  return { adults, childrenAge };
}

/** Merge occupancy into a URLSearchParams (mutates a copy and returns it). */
export function writeOccupancy(sp: URLSearchParams, occ: Occupancy): URLSearchParams {
  const next = new URLSearchParams(sp);
  next.set("adults", String(occ.adults));
  if (occ.childrenAge.length) next.set("childrenAge", occ.childrenAge.join(","));
  else next.delete("childrenAge");
  return next;
}

export function occupancyLabel(adults: number, childrenAge: number[]): string {
  const parts = [`${adults} adult${adults === 1 ? "" : "s"}`];
  const c = childrenAge.length;
  if (c) parts.push(`${c} child${c === 1 ? "" : "ren"}`);
  return parts.join(" · ");
}

/** childrenAge array for an API query — undefined when empty (so it's omitted). */
export function childrenAgeParam(childrenAge: number[]): number[] | undefined {
  return childrenAge.length ? childrenAge : undefined;
}
