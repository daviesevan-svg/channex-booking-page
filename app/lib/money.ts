// Money is formatted in ONE locale, deliberately. An undefined locale means the
// RUNTIME default, which is not the same thing on both sides of a render: en-US
// in the Worker, whatever the guest's browser is set to in the client. Where
// those disagree the server sends one string and hydration replaces it with
// another — "¥369" becoming "JP¥369" on a JPY property in an en-GB browser, or
// every price on every currency for a de-DE one — which React reports as a
// failed hydration and the guest sees as the price changing after the page
// loads. GBP and EUR happen to format identically in en-US and en-GB, which is
// the only reason this went unnoticed.
//
// en-US because it is what the Worker was already rendering, so nothing moves,
// and it has the cleanest symbols of the English locales (en-GB writes USD as
// "US$" and JPY as "JP¥").
//
// This is a DISPLAY locale, not the guest's language: a German guest sees
// "€369.00", not "369,00 €". Threading the guest's `lang` through instead would
// be more correct — but only if EVERY call site passes it, since a half-migrated
// version reintroduces exactly the mismatch this constant exists to prevent.
export const MONEY_LOCALE = "en-US";

// Currencies to render with their NARROW symbol. Intl's default `symbol`
// display has no symbol for these and falls back to the bare ISO code —
// "THB 1,234.50" where the guest expects "฿1,234.50".
//
// Deliberately a list rather than a blanket `currencyDisplay: "narrowSymbol"`:
// the narrow form also drops the prefix that tells the dollars apart, collapsing
// AUD (A$), CAD (CA$), NZD (NZ$) and SGD to a bare "$". Adding a currency to the
// list in admin General? Print it both ways first — take the narrow form only
// when the default gives back the code and the narrow one is unambiguous.
const NARROW_SYMBOL = new Set(["THB"]);

/** How `currency` should name itself. Exported for the one other place that
 *  builds its own Intl formatter (the voucher email's big gift value). */
export function currencyDisplay(currency: string): "symbol" | "narrowSymbol" {
  return NARROW_SYMBOL.has(currency.trim().toUpperCase()) ? "narrowSymbol" : "symbol";
}

// Format a Channex price string (e.g. "198.00") in the given currency.
//
// The fraction digits are Intl's, per currency — NOT a hardcoded 2. Two is
// right for most, but the zero-decimal currencies have no minor unit at all
// (see STRIPE_ZERO_DECIMAL below), and forcing a maximum of 2 on those left the
// half of a yen that the arithmetic produced on screen: "¥1,234.5" where the
// hotel means ¥1,235. It reads like a typo, and there is no such coin.
export function formatMoney(
  amount: string | number,
  currency = "USD",
  locale: string = MONEY_LOCALE,
): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (Number.isNaN(value)) return String(amount);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: currencyDisplay(currency),
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

// ---- Stripe minor units ----
// Stripe takes amounts in the currency's smallest unit, which for most is 1/100
// of the major unit — but the zero-decimal currencies ARE their smallest unit:
// ¥20,000 is 20000, not 2000000. Multiplying one of those by 100 charges the
// guest a hundred times the price, and Stripe cannot tell that apart from an
// expensive booking. https://docs.stripe.com/currencies#zero-decimal
const STRIPE_ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

// Deliberately NOT handled: Stripe's three-decimal currencies (BHD, JOD, KWD,
// OMR, TND), which take amounts ×1000 rounded to the nearest 10. None of them
// are on the currency list in admin General — add them here before one is.
// Note that formatMoney already PRINTS those with three decimals (Intl knows
// the minor unit), so adding one without coming here would show a price the
// charge doesn't match.

/** True when the currency has no minor unit at all — ¥, ₩, ₫. Sourced from
 *  Stripe's list, but it's a property of the currency, so display code can ask
 *  too: a fraction of one of these is not a real amount. */
export function isZeroDecimal(currency: string): boolean {
  return STRIPE_ZERO_DECIMAL.has(currency.trim().toUpperCase());
}

/** Minor units per major unit for `currency` at Stripe: 1 or 100. */
export function stripeMinorFactor(currency: string): number {
  return isZeroDecimal(currency) ? 1 : 100;
}

/** A major-unit amount (12.34, or 20000 for ¥) as the minor units Stripe charges. */
export function toStripeMinor(amount: number, currency: string): number {
  return Math.round(amount * stripeMinorFactor(currency));
}

/** Stripe's minor units back to a major-unit amount, for storing and display. */
export function fromStripeMinor(minor: number, currency: string): number {
  const factor = stripeMinorFactor(currency);
  return factor === 1 ? Math.round(minor) : Math.round(minor) / factor;
}
