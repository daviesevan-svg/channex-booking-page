import { describe, expect, it } from "vitest";

import { stayTotals } from "./checkout-totals";
import { cityTaxPayingChildren, computePricing, type CityTaxConfig, type TaxConfig } from "./pricing";
import type { ResolvedLine } from "./cart";

// "Children under 15 don't pay the city tax": a €2 per-person-night tax, 2 nights.
const ct = (over: Partial<CityTaxConfig> = {}): CityTaxConfig => ({
  enabled: true,
  name: "City tax",
  amount: 2,
  basis: "person_night",
  taxable: false,
  childrenExempt: true,
  maxNights: 0,
  ...over,
});
const cfg = (c: CityTaxConfig): TaxConfig => ({ inclusive: false, taxes: [], fees: [], cityTax: c });
const cityTaxOf = (c: CityTaxConfig, childrenAge?: number[], children = childrenAge?.length ?? 0) =>
  computePricing({ base: 100, nights: 2, adults: 2, children, childrenAge, rooms: 1 }, cfg(c)).charges[0]?.amount ?? 0;

describe("city tax child age limit", () => {
  it("exempts only children younger than the limit", () => {
    // 2 adults + a 15-year-old pay (3 × €2 × 2 nights); the 14- and 4-year-olds don't.
    expect(cityTaxOf(ct({ childrenExemptUnderAge: 15 }), [4, 14, 15])).toBe(12);
    expect(cityTaxPayingChildren(ct({ childrenExemptUnderAge: 15 }), 3, [4, 14, 15])).toBe(1);
  });

  it("without a limit, every child is exempt (the existing behaviour)", () => {
    expect(cityTaxOf(ct(), [4, 14, 15, 17])).toBe(8);
  });

  it("with the exemption off, every child pays whatever the limit says", () => {
    expect(cityTaxOf(ct({ childrenExempt: false, childrenExemptUnderAge: 15 }), [4, 16])).toBe(16);
  });

  it("a child whose age isn't known stays exempt (never overcharges)", () => {
    expect(cityTaxOf(ct({ childrenExemptUnderAge: 15 }), undefined, 2)).toBe(8);
    expect(cityTaxPayingChildren(ct({ childrenExemptUnderAge: 15 }), 1, [16, 17])).toBe(1);
  });

  it("room-based bases ignore children entirely", () => {
    expect(cityTaxOf(ct({ basis: "room_night", childrenExemptUnderAge: 15 }), [16])).toBe(4);
  });
});

describe("stayTotals reads the seated children's ages from the cart", () => {
  const line = (adults: number, childrenAge: number[]): ResolvedLine => ({
    roomId: "r",
    rateId: "p",
    roomTitle: "Room",
    rateTitle: "Rate",
    occupancy: { adults, children: childrenAge.length, infants: 0, childrenAge },
    total: 100,
    net: 100,
    cleaningFee: 0,
  });

  it("sums ages across rooms", () => {
    const t = stayTotals([line(2, [16]), line(1, [3, 10])], [], { nights: 1 }, cfg(ct({ childrenExemptUnderAge: 15 })));
    // 3 adults + the 16-year-old = 4 × €2.
    expect(t.pricing.charges[0].amount).toBe(8);
  });

  it("falls back to the searched party's ages when no line resolved", () => {
    const t = stayTotals([], [], { nights: 1 }, cfg(ct({ childrenExemptUnderAge: 15 })), { adults: 2, children: 1, childrenAge: [15] });
    expect(t.pricing.charges[0].amount).toBe(6);
  });
});
