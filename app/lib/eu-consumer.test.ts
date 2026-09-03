import { describe, expect, it } from "vitest";

import EN from "./locales/en";
import DE from "./locales/de";
import { isEuConsumerCountry, orderButtonLabel, payButtonLabel } from "./eu-consumer";
import { pageDefaults } from "./content";

// What's pinned here is the part that fails SILENTLY: a booking page can look
// perfect and still carry a button German law says makes the contract
// unenforceable, and nothing in the flow errors. See eu-consumer.ts.

describe("where the EU consumer rules apply", () => {
  it("covers the EU and the EEA states that took the directive on", () => {
    for (const code of ["DE", "AT", "FR", "IE", "NO", "IS", "LI"]) {
      expect(isEuConsumerCountry(code)).toBe(true);
    }
  });

  it("leaves everyone else alone", () => {
    for (const code of ["GB", "US", "TH", "CH", "AU"]) {
      expect(isEuConsumerCountry(code)).toBe(false);
    }
  });

  it("is unset-safe and case-insensitive — the country select can be blank", () => {
    expect(isEuConsumerCountry(undefined)).toBe(false);
    expect(isEuConsumerCountry("")).toBe(false);
    expect(isEuConsumerCountry(" de ")).toBe(true);
  });
});

describe("the order button", () => {
  const shipped = (lang: string) => pageDefaults("checkout", lang).completeButton;

  it("says what § 312j(3) BGB requires for a German guest", () => {
    expect(orderButtonLabel({ fallback: shipped("de"), lang: "de", eu: true })).toBe(
      "Zahlungspflichtig buchen",
    );
  });

  it("says it in English too — the law follows the hotel, not the guest's language", () => {
    expect(orderButtonLabel({ fallback: shipped("en"), lang: "en", eu: true })).toBe(
      "Book with obligation to pay",
    );
  });

  it("never overwrites the hotel's own wording", () => {
    expect(
      orderButtonLabel({ hotelWording: "  Jetzt verbindlich buchen  ", fallback: shipped("de"), lang: "de", eu: true }),
    ).toBe("Jetzt verbindlich buchen");
  });

  it("leaves a non-EU property with the wording it has always had", () => {
    expect(orderButtonLabel({ fallback: shipped("en"), lang: "en", eu: false })).toBe("Complete booking");
    expect(orderButtonLabel({ fallback: shipped("de"), lang: "de", eu: false })).toBe("Buchung abschließen");
  });

  it("falls back to English for a language with no wording of its own", () => {
    expect(payButtonLabel("xx")).toBe("Book with obligation to pay");
  });
});

describe("the withdrawal notice", () => {
  it("is translated, not left to the English fallback, in every shipped language", async () => {
    for (const lang of ["de", "fr", "es", "it", "pt", "nl", "el", "th", "tr"]) {
      const dict = (await import(`./locales/${lang}.ts`)).default as Record<string, string>;
      expect(dict.noWithdrawalRight, lang).toBeTruthy();
      expect(dict.noWithdrawalRight, lang).not.toBe(EN.noWithdrawalRight);
    }
    expect(DE.noWithdrawalRight).toContain("Widerrufsrecht");
  });
});
