// The itemised tax/fee breakdown Google reads off the final page, as
// schema.org price components.
// https://developers.google.com/hotels/hotel-prices/structured-data/hotel-price-structured-data
//
// A CompoundPriceSpecification may carry `priceComponent` line items, each a
// UnitPriceSpecification with a name, an amount and a `priceComponentType`
// drawn from Google's enumeration. Only the total is mandatory; this is the
// optional detail that lets Google see WHY the total is what it is instead of
// guessing that a bigger number than the feed's is a price discrepancy.
//
// The one rule that matters here is arithmetic: a breakdown that does not add
// up to the total is worse than no breakdown at all, because it turns a
// correct price into evidence of a wrong one. `priceComponents` therefore
// returns null rather than a set of components that miss the total — a silent
// wrong answer is the failure mode this whole feature exists to avoid.
import type { ResolvedExtra } from "./extras";
import type { Pricing } from "./pricing";

/** Google's PriceComponentTypeEnumeration. Their list, not schema.org's —
 *  schema.org's enumeration of the same name holds entirely different values
 *  (CleaningFee, Installment, Subscription…) and none of them mean "tax". */
export type PriceComponentType =
  | "Discount"
  | "ResortFee"
  | "GenericTax"
  | "ServiceFee"
  | "TransferFee";

export interface PriceComponent {
  /** Human label, shown to Google as the component's name. */
  name: string;
  amount: number;
  /** Absent on the base rate, which is the thing the others are added to. */
  type?: PriceComponentType;
}

/** Cash equality: within half a cent, so float dust in a sum of rounded parts
 *  doesn't suppress a breakdown that is actually correct. */
const MATCHES = 0.005;

/**
 * The stay's price components, or null when they don't reconstruct `total`.
 *
 * Order follows the guest's own itemisation: room, then fees and city tax,
 * then add-ons, then any VAT charged on top. Inclusive VAT is deliberately
 * NOT a component — it is already inside the base rate, and adding it would
 * count the same money twice and break the sum.
 */
export function priceComponents(
  pricing: Pick<Pricing, "base" | "charges" | "taxLines">,
  extraLines: ResolvedExtra[],
  total: number,
): PriceComponent[] | null {
  const out: PriceComponent[] = [];

  if (pricing.base > 0) out.push({ name: "Base rate", amount: pricing.base });

  for (const c of pricing.charges) {
    // A city tax is a tax the guest pays on top; a cleaning or resort charge
    // is a fee. `kind` carries that from the pricing engine, since the label
    // is operator-written and could say anything in any language.
    out.push({ name: c.label, amount: c.amount, type: c.kind === "tax" ? "GenericTax" : "ServiceFee" });
  }

  for (const x of extraLines) {
    if (x.amount === 0) continue;
    const name = x.optionName ? `${x.name} · ${x.optionName}` : x.name;
    out.push({ name: x.qty > 1 ? `${name} ×${x.qty}` : name, amount: x.amount, type: "ServiceFee" });
  }

  for (const t of pricing.taxLines) {
    out.push({ name: t.label, amount: t.amount, type: "GenericTax" });
  }

  if (out.length === 0) return null;
  const sum = out.reduce((s, c) => s + c.amount, 0);
  return Math.abs(sum - total) < MATCHES ? out : null;
}
