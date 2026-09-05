import { describe, expect, it } from "vitest";

import { priceComponents } from "./price-components";
import { computePricing, type TaxConfig } from "./pricing";
import type { ResolvedExtra } from "./extras";

const extra = (name: string, amount: number, taxable = false): ResolvedExtra => ({
  id: name, name, unit: "stay" as ResolvedExtra["unit"], unitPrice: amount, qty: 1, amount, taxable,
});

const cfg = (over: Partial<TaxConfig> = {}): TaxConfig => ({
  inclusive: false,
  taxes: [],
  fees: [],
  ...over,
});

// The whole point of the breakdown is that it reconstructs the total. These
// walk the real pricing engine rather than hand-built Pricing objects, so a
// change to how a charge is computed shows up here as a broken sum.
const stay = { base: 400, nights: 2, adults: 2, children: 0, rooms: 1 };

describe("priceComponents", () => {
  it("reconstructs a total made of room, fee, city tax and on-top VAT", () => {
    const c = cfg({
      taxes: [{ id: "vat", name: "VAT", rate: 20 }],
      fees: [{ id: "svc", name: "Service charge", kind: "percent", amount: 10, taxable: true }],
      cityTax: { enabled: true, name: "City tax", amount: 2, basis: "person_night", taxable: false, childrenExempt: true, maxNights: 0 },
    });
    const pricing = computePricing(stay, c);
    const parts = priceComponents(pricing, [], pricing.total);
    expect(parts).not.toBeNull();
    expect(parts!.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(pricing.total, 2);
  });

  it("types a city tax as a tax and a fee as a fee", () => {
    const pricing = computePricing(stay, cfg({
      fees: [{ id: "svc", name: "Service charge", kind: "fixed", amount: 15, taxable: false }],
      cityTax: { enabled: true, name: "Kurtaxe", amount: 3, basis: "room_night", taxable: false, childrenExempt: false, maxNights: 0 },
    }));
    const parts = priceComponents(pricing, [], pricing.total)!;
    // Names are operator-written; the TYPE is what tells Google which is which.
    expect(parts.find((p) => p.name === "Kurtaxe")?.type).toBe("GenericTax");
    expect(parts.find((p) => p.name === "Service charge")?.type).toBe("ServiceFee");
    expect(parts.find((p) => p.name === "Base rate")?.type).toBeUndefined();
  });

  it("includes extras, taxable and not, so the sum still lands", () => {
    const extras = [extra("Breakfast", 30, true), extra("Parking", 20, false)];
    const pricing = computePricing({ ...stay, taxableExtras: 30 }, cfg({ taxes: [{ id: "v", name: "VAT", rate: 20 }] }));
    const grandTotal = Math.round((pricing.total + 20) * 100) / 100;
    const parts = priceComponents(pricing, extras, grandTotal)!;
    expect(parts).not.toBeNull();
    expect(parts.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(grandTotal, 2);
  });

  it("never counts inclusive VAT as a component", () => {
    const pricing = computePricing(stay, cfg({ inclusive: true, taxes: [{ id: "v", name: "VAT", rate: 20 }] }));
    expect(pricing.taxIncluded).toBeGreaterThan(0);
    const parts = priceComponents(pricing, [], pricing.total)!;
    expect(parts.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(pricing.total, 2);
    expect(parts.some((p) => p.amount === pricing.taxIncluded)).toBe(false);
  });

  it("returns null rather than a breakdown that misses the total", () => {
    const pricing = computePricing(stay, cfg());
    // A total the components cannot explain — e.g. an untaxed extra the caller
    // forgot to pass. Silence beats a breakdown that contradicts the price.
    expect(priceComponents(pricing, [], pricing.total + 25)).toBeNull();
  });

  it("returns null when there is nothing to itemise", () => {
    expect(priceComponents({ base: 0, charges: [], taxLines: [] }, [], 0)).toBeNull();
  });
});
