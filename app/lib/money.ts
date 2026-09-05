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
// "THB 1,234.50" where the guest expects "฿1,234.50", "TRY" where they
// expect "₺".
//
// Deliberately a list rather than a blanket `currencyDisplay: "narrowSymbol"`:
// the narrow form also drops the prefix that tells the dollars apart, collapsing
// AUD (A$), CAD (CA$), NZD (NZ$) and SGD to a bare "$". Adding a currency to the
// list? Take the narrow form only when the default gives back the code, the
// narrow one is unambiguous (every $, £, kr and Rs collides with another
// currency here), and BOTH embedded PDF faces have the glyph — a missing one
// draws a silent .notdef box (that check kept AFN ؋, AMD ֏, BDT ৳ and KHR ៛
// out, and KGS's ⃀ is too new a codepoint to trust on guests' devices). The
// 2026-08 sweep over all 139 supported currencies picked exactly these.
const NARROW_SYMBOL = new Set([
  "THB", "TRY", // ฿ ₺
  "AZN", "CRC", "GEL", "KZT", "LAK", "MNT", "NGN", "PYG", "RUB", "UAH", // ₼ ₡ ₾ ₸ ₭ ₮ ₦ ₲ ₽ ₴
]);

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

/** The pieces of a formatted price, split around the number.
 *
 * Google's price-accuracy crawler reads the total out of an
 * `itemprop="price"` element, and that element's text should be the number
 * ALONE — a "£" or a trailing "kr" inside it is a parse away from being read
 * as part of the amount. Splitting here rather than at the call site keeps one
 * formatter: `before + number + after` reassembles to exactly what
 * formatMoney would have produced, symbol placement and per-currency digits
 * included, so tagging a price can never change what the guest sees.
 *
 * `number` keeps its group separators, because it IS the visible text. The
 * machine-readable value belongs in a `content` attribute alongside it (which
 * is the pattern Google's own guide prescribes for dates) — that is `value`,
 * built from the SAME parts with the group separators dropped, so the tagged
 * number and the displayed number can never drift apart.
 */
export function formatMoneyParts(
  amount: string | number,
  currency = "USD",
  locale: string = MONEY_LOCALE,
): { before: string; number: string; after: string; value: string } {
  const value = typeof amount === "string" ? Number(amount) : amount;
  const whole = formatMoney(amount, currency, locale);
  const plain = { before: "", number: whole, after: "", value: String(value) };
  if (Number.isNaN(value)) return { before: "", number: whole, after: "", value: "" };
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: currencyDisplay(currency),
    }).formatToParts(value);
    // Everything from the first digit-ish part to the last is the number; what
    // sits outside that run is symbol and spacing, wherever the locale put it.
    const numeric = new Set(["integer", "group", "decimal", "fraction", "minusSign", "plusSign"]);
    const first = parts.findIndex((p) => numeric.has(p.type));
    if (first < 0) return plain;
    let last = first;
    for (let i = first; i < parts.length; i++) if (numeric.has(parts[i].type)) last = i;
    const join = (from: number, to: number) =>
      parts.slice(from, to).map((p) => p.value).join("");
    return {
      before: join(0, first),
      number: join(first, last + 1),
      after: join(last + 1, parts.length),
      value: parts
        .slice(first, last + 1)
        .filter((p) => p.type !== "group")
        .map((p) => (p.type === "decimal" ? "." : p.value))
        .join(""),
    };
  } catch {
    return plain;
  }
}

// ---- Stripe minor units ----
// Stripe takes amounts in the currency's smallest unit, which for most is 1/100
// of the major unit — but the zero-decimal currencies ARE their smallest unit:
// ¥20,000 is 20000, not 2000000. Multiplying one of those by 100 charges the
// guest a hundred times the price, and Stripe cannot tell that apart from an
// expensive booking. https://docs.stripe.com/currencies#zero-decimal
//
// UGX and ISK are NOT in this set even though they display without decimals:
// both "became effectively zero-decimal" after Stripe fixed its API shape, so
// the API still takes them ×100 and rejects any amount not divisible by 100
// (probed against the live test API, 2026-08-12 — amount=500 ugx is USh 5.00,
// amount=501 is an error). Treating them as zero-decimal here would UNDERcharge
// a hundredfold; the divisible-by-100 rule falls out of toStripeMinor rounding
// to the displayed (whole-unit) precision before scaling.
const STRIPE_ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF",
]);

// Stripe's three-decimal currencies take amounts ×1000, and the API requires
// the last digit to be 0 — the smallest chargeable step is 10 minor units, i.e.
// two decimal places of the major unit. formatMoney prints whatever precision
// the data carries (Intl gives these three decimals), so price these in two
// decimals; a third decimal place would show a price the charge can't match.
const STRIPE_THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

const norm = (currency: string) => currency.trim().toUpperCase();

// How many fraction digits formatMoney shows for `currency` — Intl's
// per-currency default in MONEY_LOCALE, the same formatter formatMoney builds.
// Charging derives from this so a guest is charged the number they saw.
const displayDigitsCache = new Map<string, number>();
function displayFractionDigits(currency: string): number {
  const c = norm(currency);
  let digits = displayDigitsCache.get(c);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat(MONEY_LOCALE, { style: "currency", currency: c })
        .resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    displayDigitsCache.set(c, digits);
  }
  return digits;
}

/** True when the currency DISPLAYS with no minor unit — ¥, ₩, ₫, but also ISK
 *  and UGX, which Stripe still charges ×100. Display code only: the charge
 *  factor is stripeMinorFactor, and they disagree exactly where it matters. */
export function isZeroDecimal(currency: string): boolean {
  return displayFractionDigits(currency) === 0;
}

/** Minor units per major unit for `currency` at Stripe: 1, 100 or 1000. */
export function stripeMinorFactor(currency: string): number {
  const c = norm(currency);
  if (STRIPE_THREE_DECIMAL.has(c)) return 1000;
  return STRIPE_ZERO_DECIMAL.has(c) ? 1 : 100;
}

/** A major-unit amount (12.34, or 20000 for ¥) as the minor units Stripe
 *  charges. The amount is first rounded to the currency's DISPLAY precision,
 *  so the charge always equals the price formatMoney showed the guest — for
 *  currencies that display whole units but charge ×100 (ISK, UGX, COP, HUF,
 *  IDR…) a fractional computed amount would otherwise charge a different
 *  number than the page did, and for ISK/UGX Stripe outright rejects it. */
export function toStripeMinor(amount: number, currency: string): number {
  // Three-decimal: display shows 3 digits but the API's finest step is 10
  // minor units, so charge at two-decimal precision (last digit 0, as required).
  if (STRIPE_THREE_DECIMAL.has(norm(currency))) return Math.round(amount * 100) * 10;
  const scale = 10 ** displayFractionDigits(currency);
  const displayed = Math.round(amount * scale) / scale;
  return Math.round(displayed * stripeMinorFactor(currency));
}

/** Stripe's minor units back to a major-unit amount, for storing and display. */
export function fromStripeMinor(minor: number, currency: string): number {
  return Math.round(minor) / stripeMinorFactor(currency);
}

/** Round a DERIVED minor-unit amount (a platform fee computed in bps) to
 *  something Stripe will accept: whole minor units, and for the three-decimal
 *  currencies the same last-digit-0 rule as the charge itself — a 256-fils
 *  application fee on a KWD session is rejected exactly like a 5124 charge. */
export function roundStripeMinor(minor: number, currency: string): number {
  if (STRIPE_THREE_DECIMAL.has(norm(currency))) return Math.round(minor / 10) * 10;
  return Math.round(minor);
}
