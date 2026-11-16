import { describe, expect, it } from "vitest";

import type { RatePlan, RoomWithRates } from "./channex/types";
import { ratePlansForParty, readOccupancy } from "./occupancy";

function occ(adults: string | undefined, childrenAge?: string) {
  const sp = new URLSearchParams();
  if (adults !== undefined) sp.set("adults", adults);
  if (childrenAge !== undefined) sp.set("childrenAge", childrenAge);
  return readOccupancy(sp);
}

describe("readOccupancy adults cap", () => {
  it("defaults missing or invalid adults to 2", () => {
    expect(occ(undefined).adults).toBe(2);
    expect(occ("").adults).toBe(2);
    expect(occ("abc").adults).toBe(2);
    expect(occ("0").adults).toBe(2);
  });

  it("keeps a normal party", () => {
    expect(occ("1").adults).toBe(1);
    expect(occ("2").adults).toBe(2);
    expect(occ("12").adults).toBe(12);
  });

  it("clamps adults at 25 (does not 500)", () => {
    expect(occ("25").adults).toBe(25);
    expect(occ("26").adults).toBe(25);
    expect(occ("9999").adults).toBe(25);
    expect(occ("1e6").adults).toBe(25);
  });

  it("floors a negative adults value at 1", () => {
    expect(occ("-3").adults).toBe(1);
  });

  it("does not cap childrenAge length (no matching product rule on the reader)", () => {
    const ages = Array.from({ length: 20 }, (_, i) => String(i)).join(",");
    expect(occ("2", ages).childrenAge).toHaveLength(20);
  });
});

describe("ratePlansForParty order", () => {
  const plan = (id: string, totalPrice: string, adults = 2): RatePlan =>
    ({ id, title: id, totalPrice, occupancy: { adults, children: 0, infants: 0 } }) as RatePlan;
  const room = (ratePlans: RatePlan[]) => ({ id: "r", title: "Room", ratePlans }) as unknown as RoomWithRates;
  const ids = (rs: RatePlan[]) => rs.map((r) => r.id);

  it("lists rates cheapest first, whatever order the admin created them in", () => {
    const rs = ratePlansForParty(room([plan("bb", "20100.50"), plan("ai", "30500.50"), plan("hb", "23100.50")]), 2);
    expect(ids(rs)).toEqual(["bb", "hb", "ai"]);
  });

  it("keeps the admin order between equal prices", () => {
    expect(ids(ratePlansForParty(room([plan("b", "100"), plan("a", "100"), plan("c", "50")]), 2))).toEqual(["c", "b", "a"]);
  });

  it("sorts on the variant priced for the party, not another occupancy", () => {
    // "x" is cheap only at 1 adult; for a party of 2 its 2-adult variant counts.
    const rs = ratePlansForParty(room([plan("x", "80", 1), plan("x", "200", 2), plan("y", "150", 2)]), 2);
    expect(rs.map((r) => [r.id, r.totalPrice])).toEqual([["y", "150"], ["x", "200"]]);
  });
});
