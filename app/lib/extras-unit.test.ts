import { describe, expect, it } from "vitest";

import { parseExtraUnit, resolveExtras, UNIT_LABEL, UNITS, unitMultiplier, type Extra } from "./extras";

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
