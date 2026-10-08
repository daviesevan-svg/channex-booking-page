import { describe, expect, it } from "vitest";
import { channexCharges } from "./channex-charges";

const line = (total: number) => ({ total, occupancy: { adults: 2, children: 0 } });
const sum = (xs: { total_price: string }[]) => xs.reduce((n, x) => n + Number(x.total_price), 0);

describe("channexCharges", () => {
  it("sends on-top VAT as a room tax and the fee as a service", () => {
    const { services, roomTaxes } = channexCharges({
      pricing: {
        charges: [{ label: "Environmental Fee", amount: 14, kind: "fee" }],
        taxLines: [{ label: "VAT (13%)", amount: 284.75 }],
        taxIncluded: 0,
      },
      extraLines: [],
      lines: [line(2190.35)],
      nights: 7,
    });
    expect(services.map((s) => s.name)).toEqual(["Environmental Fee"]);
    expect(roomTaxes(0)).toEqual([
      { name: "VAT (13%)", type: "vat", is_inclusive: false, total_price: "284.75" },
    ]);
  });

  it("sends city tax as a city_tax room tax, not a service", () => {
    const { services, roomTaxes } = channexCharges({
      pricing: { charges: [{ label: "City tax", amount: 5, kind: "tax" }], taxLines: [], taxIncluded: 0 },
      extraLines: [],
      lines: [line(200)],
      nights: 2,
    });
    expect(services).toEqual([]);
    expect(roomTaxes(0)).toEqual([{ name: "City tax", type: "city_tax", is_inclusive: false, total_price: "5.00" }]);
  });

  it("sends inclusive VAT as an inclusive tax", () => {
    const { roomTaxes } = channexCharges({
      pricing: { charges: [], taxLines: [], taxIncluded: 18.18 },
      extraLines: [],
      lines: [line(100)],
      nights: 1,
    });
    expect(roomTaxes(0)).toEqual([{ name: "VAT", type: "vat", is_inclusive: true, total_price: "18.18" }]);
  });

  it("splits taxes across rooms without losing a cent", () => {
    const { roomTaxes } = channexCharges({
      pricing: { charges: [], taxLines: [{ label: "VAT (7%)", amount: 100 }], taxIncluded: 0 },
      extraLines: [],
      lines: [line(100), line(100), line(100)],
      nights: 2,
    });
    const parts = [0, 1, 2].flatMap((i) => roomTaxes(i));
    expect(parts).toHaveLength(3);
    expect(Math.round(sum(parts) * 100)).toBe(10000);
  });

  it("sends no taxes key content when there are none", () => {
    const { services, roomTaxes } = channexCharges({
      pricing: { charges: [], taxLines: [], taxIncluded: 0 },
      extraLines: [],
      lines: [line(100)],
      nights: 1,
    });
    expect(services).toEqual([]);
    expect(roomTaxes(0)).toEqual([]);
  });
});
