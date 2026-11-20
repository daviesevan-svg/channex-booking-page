import { describe, expect, it } from "vitest";

import { computePricing, guestChargeLabels, taxConfigFrom, type CityTaxConfig, type FeeRule, type TaxRule } from "./pricing";
import { validateTaxDocument } from "./manage-validate";
import { serializeTaxConfig } from "./manage-serialize";
import type { SiteSettings } from "./content";

// A Slovak guest house: "the city tax name is one text for all languages, so I
// had to call it 'Daň za ubytovanie (city tax)'".
const SK = {
  lang: "sk",
  t: (k: string) => ({ cleaningFee: "Poplatok za upratovanie", cityTax: "Daň za ubytovanie" })[k] ?? k,
};
const vat: TaxRule = { id: "v", name: "VAT", rate: 20, nameTranslations: { sk: "DPH" } };
const fee: FeeRule = { id: "f", name: "Service charge", kind: "percent", amount: 10, taxable: false, nameTranslations: { sk: "Servisný poplatok" } };
const flat: FeeRule = { id: "g", name: "Towels", kind: "fixed", amount: 5, taxable: false };
const city = (over: Partial<CityTaxConfig> = {}): CityTaxConfig => ({
  enabled: true,
  name: "Tourist tax",
  amount: 2,
  basis: "person_night",
  taxable: false,
  childrenExempt: false,
  maxNights: 0,
  nameTranslations: { sk: "Miestny poplatok" },
  ...over,
});
const settings = (ct: CityTaxConfig) => ({ taxesInclusive: false, taxes: [vat], fees: [fee, flat], cityTax: ct });
const labels = (cfg: ReturnType<typeof taxConfigFrom>) =>
  (({ charges, taxLines }) => [...charges, ...taxLines].map((l) => l.label))(
    computePricing({ base: 100, nights: 2, adults: 2, children: 0, rooms: 1, cleaningFee: 15 }, cfg),
  );

describe("tax and fee names per guest language", () => {
  it("guest pages show each name in the guest's language, falling back to the typed name", () => {
    expect(labels(taxConfigFrom(settings(city()), SK))).toEqual([
      "Poplatok za upratovanie",
      "Servisný poplatok (10%)",
      "Towels", // no Slovak name given → the main one
      "Miestny poplatok",
      "DPH (20%)",
    ]);
  });

  it("without a guest (the stored booking, the API, admin) names stay as typed", () => {
    expect(labels(taxConfigFrom(settings(city())))).toEqual([
      "Cleaning fee",
      "Service charge (10%)",
      "Towels",
      "Tourist tax",
      "VAT (20%)",
    ]);
  });

  it("an untranslated city tax left at the default name reads in the guest's language", () => {
    const cfg = taxConfigFrom(settings(city({ name: "City tax", nameTranslations: undefined })), SK);
    expect(labels(cfg)).toContain("Daň za ubytovanie");
    // …but a name the property chose itself is never replaced by our word.
    expect(labels(taxConfigFrom(settings(city({ nameTranslations: undefined })), SK))).toContain("Tourist tax");
  });

  it("relabels a booking's stored lines for the guest's emails", () => {
    const map = guestChargeLabels(settings(city()), SK);
    expect(map.get("Cleaning fee")).toBe("Poplatok za upratovanie");
    expect(map.get("VAT (20%)")).toBe("DPH (20%)");
    expect(map.get("Service charge (10%)")).toBe("Servisný poplatok (10%)");
    expect(map.get("Tourist tax")).toBe("Miestny poplatok");
    expect(map.has("Towels")).toBe(false);
  });
});

describe("name_translations in the manage API", () => {
  const doc = {
    taxes_inclusive: false,
    taxes: [{ name: "VAT", rate: 20, name_translations: { sk: "DPH", cs: "  " } }],
    fees: [{ name: "Service charge", kind: "percent", amount: 10, taxable: false, name_translations: { sk: "Servisný poplatok" } }],
    city_tax: { enabled: true, name: "City tax", amount: 2, basis: "person_night", children_exempt: false, name_translations: { sk: "Daň za ubytovanie" } },
  };

  it("accepts and stores them (blank entries dropped), and GET returns the same shape", () => {
    const v = validateTaxDocument(doc);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.taxes[0].nameTranslations).toEqual({ sk: "DPH" });
    expect(v.value.fees[0].nameTranslations).toEqual({ sk: "Servisný poplatok" });
    expect(v.value.cityTax?.nameTranslations).toEqual({ sk: "Daň za ubytovanie" });

    const stored = { taxesInclusive: false, taxes: v.value.taxes, fees: v.value.fees, cityTax: v.value.cityTax ?? undefined } as SiteSettings;
    const out = serializeTaxConfig(stored);
    expect(out.taxes[0]).toMatchObject({ name: "VAT", name_translations: { sk: "DPH" } });
    expect(out.taxes[0]).not.toHaveProperty("nameTranslations");
    // A read-modify-write keeps them.
    const again = validateTaxDocument(JSON.parse(JSON.stringify(out)));
    expect(again.ok && again.value.cityTax?.nameTranslations).toEqual({ sk: "Daň za ubytovanie" });
    expect(again.ok && again.value.fees[0].nameTranslations).toEqual({ sk: "Servisný poplatok" });
  });

  it("rejects an unknown language code or the base language", () => {
    expect(validateTaxDocument({ ...doc, taxes: [{ name: "VAT", rate: 20, name_translations: { xx: "?" } }] }).ok).toBe(false);
    expect(validateTaxDocument({ ...doc, taxes: [{ name: "VAT", rate: 20, name_translations: { en: "VAT" } }] }).ok).toBe(false);
  });
});
