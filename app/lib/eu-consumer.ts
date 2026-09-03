// EU/EEA consumer-contract rules that change what the guest sees at checkout.
//
// Two of them, and both are triggered by where the PROPERTY is — not by the
// guest's language, and not by an admin toggle. A German hotel that never finds
// the checkbox is exactly the hotel these rules exist to catch, and a guest
// reading the page in English is owed the same button as one reading it in
// German.
//
//  * Art. 8(2) CRD, § 312j(3) BGB in Germany: the button that places the order
//    must say in words that it costs money. "Buchung abschließen" is the
//    wording German courts reject; "Zahlungspflichtig buchen" is the wording
//    the statute itself names. A button that fails this can leave the contract
//    unenforceable, so it is not a copy preference.
//  * Art. 16(l) CRD, § 312g(2) Nr. 9 BGB: accommodation for specific dates
//    carries no 14-day right of withdrawal. The guest is told, because the
//    alternative is a guest who cancels expecting a refund the hotel never
//    owed, and a chargeback the hotel then has to argue about.
//
// The country is `settings.addressCountry` — the select on the admin Property
// page, ISO 3166-1 alpha-2, also feeding the Google feeds. Unset means we can't
// tell, so nothing changes and the Legal block on the General page says so.

/** EU 27 + the three EEA states that took the Consumer Rights Directive on. */
const EU_EEA = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
  "SE", "IS", "LI", "NO",
]);

export function isEuConsumerCountry(code: string | undefined): boolean {
  return Boolean(code) && EU_EEA.has(String(code).trim().toUpperCase());
}

/**
 * The order button's wording where Art. 8(2) applies, per guest language.
 *
 * Deliberately blunt in every language — the test is whether the guest can
 * misread the button as anything other than "this costs money", so the clumsy
 * phrasing is the point and must survive a copy pass.
 */
const PAY_BUTTON: Record<string, string> = {
  en: "Book with obligation to pay",
  de: "Zahlungspflichtig buchen",
  fr: "Réserver avec obligation de paiement",
  es: "Reservar con obligación de pago",
  it: "Prenota con obbligo di pagamento",
  pt: "Reservar com obrigação de pagamento",
  nl: "Reserveren met betalingsverplichting",
  el: "Κράτηση με υποχρέωση πληρωμής",
  th: "จองโดยมีภาระผูกพันในการชำระเงิน",
  tr: "Ödeme yükümlülüğüyle rezervasyon yap",
};

export function payButtonLabel(lang: string): string {
  return PAY_BUTTON[lang] ?? PAY_BUTTON.en;
}

/**
 * What the order button says.
 *
 * Precedence, and the reason for each step: the hotel's own wording always
 * wins — a hotel that typed "Jetzt zahlungspflichtig buchen" has thought about
 * this harder than we have, and silently replacing their words would be a
 * worse bug than the one this function exists to fix. Otherwise the EU wording
 * replaces OUR default, which is the case that matters: nobody chose "Buchung
 * abschließen", it was just what shipped.
 */
export function orderButtonLabel(opts: {
  /** The hotel's stored override for this field, if any. */
  hotelWording?: string;
  /** Our default for this language. */
  fallback: string;
  lang: string;
  eu: boolean;
}): string {
  const own = opts.hotelWording?.trim();
  if (own) return own;
  return opts.eu ? payButtonLabel(opts.lang) : opts.fallback;
}
