import { describe, expect, it } from "vitest";

import { clampQty, maxQtyOf, parseExtraUnit, qtyLocked, resolveExtras, UNIT_LABEL, UNITS, unitMultiplier, type Extra } from "./extras";

describe("per-item extras", () => {
  it("is a unit the admin menu, the API and the label all know", () => {
    expect(UNITS).toContain("item");
    expect(UNIT_LABEL.item).toBe("each");
  });

  it("scales by quantity only — three tanks at $35 is $105 whatever the stay", () => {
    expect(unitMultiplier("item", 4, 6)).toBe(1);
    const tank = { id: "tank", name: "Propane tank (20 lb)", unit: "item", price: 35, scope: "booking", active: true } as unknown as Extra;
    const lines = resolveExtras([tank], [{ id: "tank", qty: 3 }], 4, 6);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ unit: "item", unitPrice: 35, qty: 3, amount: 105 });
  });

  it("leaves per-night pricing exactly as it was", () => {
    const pet = { id: "pet", name: "Pet fee", unit: "night", price: 20, scope: "booking", active: true } as unknown as Extra;
    const [line] = resolveExtras([pet], [{ id: "pet", qty: 1 }], 3, 2);
    expect(line).toMatchObject({ unit: "night", amount: 60 });
    expect(UNIT_LABEL.night).toBe("per night");
  });

  it("reads what operators actually type for a unit", () => {
    expect(parseExtraUnit("item")).toBe("item");
    expect(parseExtraUnit("each")).toBe("item");
    expect(parseExtraUnit(" Each ")).toBe("item");
    expect(parseExtraUnit("per night")).toBe("night");
    expect(parseExtraUnit("night")).toBe("night");
    expect(parseExtraUnit("Comes with a regulator")).toBeUndefined();
    expect(parseExtraUnit(null)).toBeUndefined();
  });
});

describe("per-extra quantity limit (maxQty)", () => {
  // Camptel's Pet Fee: options already say "1 pet" / "2 pets" — the quantity
  // must be exactly 1, whatever the URL or an API body claims.
  const petFee = {
    id: "pet",
    name: "Pet fee",
    unit: "night",
    maxQty: 1,
    scope: "booking",
    active: true,
    options: [
      { id: "one", name: "1 pet", price: 35 },
      { id: "two", name: "2 pets", price: 70 },
    ],
  } as unknown as Extra;
  const tank = { id: "tank", name: "Propane tank", unit: "item", price: 35, scope: "booking", active: true } as unknown as Extra;
  const towels = { id: "towels", name: "Beach towels", unit: "stay", price: 5, maxQty: 4, active: true } as unknown as Extra;

  it("charges a locked extra exactly once even when the selection says qty 5", () => {
    const [line] = resolveExtras([petFee], [{ id: "pet", optionId: "two", qty: 5 }], 3, 2);
    expect(line).toMatchObject({ optionId: "two", qty: 1, amount: 210 }); // 70 × 3 nights × 1
  });

  it("caps a bounded extra at its limit and leaves an unlimited one alone", () => {
    const [capped] = resolveExtras([towels], [{ id: "towels", qty: 9 }], 1, 2);
    expect(capped).toMatchObject({ qty: 4, amount: 20 });
    const [free] = resolveExtras([tank], [{ id: "tank", qty: 9 }], 1, 2);
    expect(free).toMatchObject({ qty: 9, amount: 315 }); // tanks are sold per tank
  });

  it("treats absent, zero and garbage limits as no limit", () => {
    expect(maxQtyOf({})).toBe(Infinity);
    expect(maxQtyOf({ maxQty: 0 })).toBe(Infinity);
    expect(maxQtyOf({ maxQty: Number.NaN })).toBe(Infinity);
    expect(maxQtyOf({ maxQty: 2.9 })).toBe(2);
    expect(qtyLocked({ maxQty: 1 })).toBe(true);
    expect(qtyLocked({ maxQty: 2 })).toBe(false);
    expect(clampQty({ maxQty: 1 }, "7")).toBe(1);
    expect(clampQty({}, -3)).toBe(1);
  });
});
