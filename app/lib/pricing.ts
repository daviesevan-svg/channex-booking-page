// Shared, pure pricing engine. Given a room subtotal (the "just a price" number
// from inventory, after any promo) plus the property's tax/fee config, it
// produces the guest-facing breakdown and grand total. Used by checkout and
// confirmation so they never disagree.
//
// One global switch decides inclusive vs on-top VAT; city tax and fees are
// always added on top, each with a single "VAT applies" flag.

/** A percentage tax, e.g. VAT 20. */
export interface TaxRule {
  id: string;
  name: string;
  rate: number; // percent
}

export type CityTaxBasis = "person_night" | "room_night" | "room_stay";

export interface CityTaxConfig {
  enabled: boolean;
  name: string;
  amount: number;
  basis: CityTaxBasis;
  /** VAT (the taxes below) is added to the city tax too. */
  taxable: boolean;
  /** Children don't count towards a per-person city tax. */
  childrenExempt: boolean;
  /** Cap on nights charged (0 = no cap). */
  maxNights: number;
}

export interface FeeRule {
  id: string;
  name: string;
  kind: "percent" | "fixed";
  amount: number;
  /** VAT is added on top of this fee. */
  taxable: boolean;
}

export interface TaxConfig {
  /** true = the prices already include the taxes; false = add them on top. */
  inclusive: boolean;
  taxes: TaxRule[];
  fees: FeeRule[];
  cityTax?: CityTaxConfig;
}

export interface PricingInput {
  /** Room subtotal across the stay, after any promo discount. */
  base: number;
  nights: number;
  adults: number;
  children: number;
  /** Number of rooms booked. */
  rooms: number;
  /** Total cleaning fee across the booked rooms (per stay). VAT always applies. */
  cleaningFee?: number;
}

export interface PriceLine {
  label: string;
  amount: number;
}

export interface Pricing {
  base: number;
  /** Fees + city tax, pre-VAT, in display order. */
  charges: PriceLine[];
  /** VAT lines added on top (on-top mode only). */
  taxLines: PriceLine[];
  /** VAT already contained in the prices (inclusive mode). */
  taxIncluded: number;
  /** Grand total the guest pays. */
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computePricing(input: PricingInput, cfg: TaxConfig): Pricing {
  const { base, nights, adults, children, rooms } = input;
  const taxes = cfg.taxes ?? [];
  const fees = cfg.fees ?? [];
  const combinedRate = taxes.reduce((s, t) => s + (t.rate || 0), 0) / 100;
  const inclusive = cfg.inclusive === true;

  const charges: PriceLine[] = [];
  let chargesTotal = 0;
  // The portion of fees/city-tax that VAT also applies to (on top of the room).
  let taxableExtra = 0;

  // Cleaning fee — flat, per stay, always counts towards VAT (part of the room price).
  const cleaning = round2(input.cleaningFee ?? 0);
  if (cleaning > 0) {
    charges.push({ label: "Cleaning fee", amount: cleaning });
    chargesTotal += cleaning;
    taxableExtra += cleaning;
  }

  for (const f of fees) {
    const amount = round2(f.kind === "percent" ? (base * (f.amount || 0)) / 100 : f.amount || 0);
    if (amount <= 0) continue;
    charges.push({ label: f.kind === "percent" ? `${f.name} (${f.amount}%)` : f.name, amount });
    chargesTotal += amount;
    if (f.taxable) taxableExtra += amount;
  }

  const ct = cfg.cityTax;
  if (ct && ct.enabled && ct.amount > 0) {
    const chargeableNights = ct.maxNights > 0 ? Math.min(nights, ct.maxNights) : nights;
    const persons = adults + (ct.childrenExempt ? 0 : children);
    const units =
      ct.basis === "person_night"
        ? persons * chargeableNights
        : ct.basis === "room_night"
          ? rooms * chargeableNights
          : rooms; // room_stay
    const amount = round2(ct.amount * units);
    if (amount > 0) {
      charges.push({ label: ct.name || "City tax", amount });
      chargesTotal += amount;
      if (ct.taxable) taxableExtra += amount;
    }
  }

  // VAT applies to the room plus any taxable fee/city-tax.
  const taxableBase = base + taxableExtra;
  const taxLines: PriceLine[] = [];
  let taxIncluded = 0;
  let taxAdded = 0;

  for (const t of taxes) {
    const rate = (t.rate || 0) / 100;
    if (rate <= 0) continue;
    if (inclusive) {
      // Carve this tax's share out of the (combined) inclusive price.
      taxIncluded += round2((taxableBase * rate) / (1 + combinedRate));
    } else {
      const amount = round2(taxableBase * rate);
      taxAdded += amount;
      taxLines.push({ label: `${t.name} (${t.rate}%)`, amount });
    }
  }

  return {
    base: round2(base),
    charges,
    taxLines,
    taxIncluded: round2(taxIncluded),
    total: round2(base + chargesTotal + taxAdded),
  };
}

/** Build the engine's config from the loosely-typed site settings. */
export function taxConfigFrom(settings: {
  taxesInclusive?: boolean;
  taxes?: TaxRule[];
  fees?: FeeRule[];
  cityTax?: CityTaxConfig;
}): TaxConfig {
  return {
    inclusive: settings.taxesInclusive === true,
    taxes: settings.taxes ?? [],
    fees: settings.fees ?? [],
    cityTax: settings.cityTax,
  };
}
