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

/** A seasonal city-tax rate: an annual recurring date range (month-day, no
 *  year) with its own nightly amount. Greek-style overnight fees change by
 *  season (e.g. Nov–Mar €2, Apr–Oct €8) and a range may wrap the year end. */
export interface CityTaxSeason {
  /** Inclusive "MM-DD" bounds. from > to means the range wraps the year end. */
  from: string;
  to: string;
  amount: number;
}

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
  /** Advanced: 2–3 seasonal rates. Each night is charged at the rate of the
   *  season containing its DATE (a cross-season stay mixes rates, per night);
   *  nights outside every season fall back to `amount`. */
  seasons?: CityTaxSeason[];
}

/** The nightly city-tax amount for a calendar date (ISO yyyy-mm-dd). With
 *  seasonal rates the seasons alone define the price — the first season whose
 *  annual range contains the date wins, and a date outside every season is NOT
 *  charged (the base amount is disabled in the editor while seasons are on).
 *  Lexicographic MM-DD comparison; from > to wraps the year end (Nov–Mar). */
export function cityTaxNightlyAmount(ct: CityTaxConfig, isoDate: string): number {
  if (!ct.seasons?.length) return ct.amount;
  const md = isoDate.slice(5, 10);
  for (const s of ct.seasons) {
    if (!s.from || !s.to) continue;
    const hit = s.from <= s.to ? md >= s.from && md <= s.to : md >= s.from || md <= s.to;
    if (hit) return s.amount;
  }
  return 0;
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
  /** Check-in date (ISO yyyy-mm-dd). Lets a seasonal city tax price each night
   *  by its own date; without it, seasonal rates fall back to the base amount. */
  checkin?: string;
  /** Sum of VAT-applicable extras. Folded into the VAT base and the total;
   *  non-taxable extras are added on top by the caller. */
  taxableExtras?: number;
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
  if (ct && ct.enabled && (ct.amount > 0 || ct.seasons?.some((s) => s.amount > 0))) {
    const chargeableNights = ct.maxNights > 0 ? Math.min(nights, ct.maxNights) : nights;
    const persons = adults + (ct.childrenExempt ? 0 : children);
    // Seasonal rates price each charged night by its own DATE (a stay spanning
    // two seasons mixes rates); needs the check-in date, else the base amount
    // applies to every night. UTC date math so it's client/server identical.
    const nightlySum = (() => {
      if (!ct.seasons?.length || !input.checkin) return ct.amount * chargeableNights;
      const start = Date.parse(`${input.checkin}T00:00:00Z`);
      if (Number.isNaN(start)) return ct.amount * chargeableNights;
      let sum = 0;
      for (let i = 0; i < chargeableNights; i++) {
        sum += cityTaxNightlyAmount(ct, new Date(start + i * 86400000).toISOString().slice(0, 10));
      }
      return sum;
    })();
    const amount = round2(
      ct.basis === "person_night"
        ? nightlySum * persons
        : ct.basis === "room_night"
          ? nightlySum * rooms
          : // room_stay: one charge per room, at the check-in date's seasonal rate.
            (input.checkin ? cityTaxNightlyAmount(ct, input.checkin) : ct.amount) * rooms,
    );
    if (amount > 0) {
      charges.push({ label: ct.name || "City tax", amount });
      chargesTotal += amount;
      if (ct.taxable) taxableExtra += amount;
    }
  }

  // VAT applies to the room, taxable fees/city-tax, and any VAT-applicable extras.
  const taxableExtras = round2(input.taxableExtras ?? 0);
  const taxableBase = base + taxableExtra + taxableExtras;
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
    // taxableExtras are part of the priced total here (inclusive: gross already
    // holds VAT; on-top: their VAT is in taxAdded). Untaxed extras added by caller.
    total: round2(base + chargesTotal + taxableExtras + taxAdded),
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
