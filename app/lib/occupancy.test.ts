import { describe, expect, it } from "vitest";

import { readOccupancy } from "./occupancy";

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
