import { isCalendarDate } from "./api-query";
import { MAX_STAY_NIGHTS } from "./dates";
import { MAX_ADULTS } from "./occupancy";

// A generous API party ceiling; ages retain the documented child range.
export const MAX_API_CHILDREN = 25;
export const MAX_CHILD_AGE = 17;

type AvailabilityInput = {
  checkin: string;
  checkout: string;
  nights: number;
  adults: number;
  childrenAge: number[];
};

/** Validate before allocating a child array or loading settings/inventory. */
export function availabilityInput(query: URLSearchParams): AvailabilityInput | { error: string } {
  const checkin = query.get("checkin") ?? "";
  const checkout = query.get("checkout") ?? "";
  if (!isCalendarDate(checkin) || !isCalendarDate(checkout)) {
    return { error: "`checkin` and `checkout` must be real calendar dates (YYYY-MM-DD)." };
  }
  const nights = (Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86_400_000;
  if (nights < 1 || nights > MAX_STAY_NIGHTS) {
    return { error: `Check-out must be after check-in, with a stay of 1–${MAX_STAY_NIGHTS} nights.` };
  }
  const integer = (raw: string, max: number, min = 0): number | null =>
    /^\d+$/.test(raw) && raw.length <= 2 && Number(raw) >= min && Number(raw) <= max ? Number(raw) : null;
  const adults = integer(query.get("adults") ?? "2", MAX_ADULTS, 1);
  if (adults == null) return { error: `\`adults\` must be an integer from 1 to ${MAX_ADULTS}.` };
  const children = integer(query.get("children") ?? "0", MAX_API_CHILDREN);
  if (children == null) return { error: `\`children\` must be an integer from 0 to ${MAX_API_CHILDREN}.` };

  const ages = query.get("children_ages");
  let childrenAge: number[];
  if (ages) {
    // Bound the string before split/map: an oversized comma list must not
    // allocate an oversized intermediate array, even if all ages are valid.
    if (ages.length > MAX_API_CHILDREN * 4) return { error: `At most ${MAX_API_CHILDREN} child ages are allowed.` };
    const parts = ages.split(",");
    if (parts.length > MAX_API_CHILDREN) return { error: `At most ${MAX_API_CHILDREN} child ages are allowed.` };
    const parsed = parts.map((age) => integer(age.trim(), MAX_CHILD_AGE));
    if (parsed.some((age) => age == null)) return { error: `Each child age must be an integer from 0 to ${MAX_CHILD_AGE}.` };
    childrenAge = parsed as number[];
  } else {
    childrenAge = Array.from({ length: children }, () => 8);
  }
  return { checkin, checkout, nights, adults, childrenAge };
}
