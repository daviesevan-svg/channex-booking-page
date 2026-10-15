import { describe, expect, it } from "vitest";

import { enabledLanguages, langFromRequest, negotiateLang } from "./content";
import { adminLangFromRequest, ADMIN_LANGS } from "./admin-i18n";
import { makeTranslator } from "./i18n";
import { adminDictFor } from "./admin-i18n-locales.server";
import "./i18n-locales.server";
import ENGUEST from "./locales/en";
import MKGUEST from "./locales/mk";
import ENADMIN from "./admin-locales/en";
import MKADMIN from "./admin-locales/mk";
import { SUPPORTED_CURRENCIES, isSupportedCurrency } from "./currencies";
import { formatMoney } from "./money";
import { payButtonLabel } from "./eu-consumer";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();

describe("Macedonian guest language", () => {
  it("is selectable and negotiable once a hotel enables it", () => {
    const hotel = { languages: ["en", "mk"], defaultLanguage: "en" };
    expect(enabledLanguages(hotel)).toEqual(["en", "mk"]);
    expect(langFromRequest(req("https://h.test/x?lang=mk"), hotel)).toBe("mk");
    expect(negotiateLang("mk-MK,mk;q=0.9,en;q=0.5", ["en", "mk"])).toBe("mk");
    // Not enabled → falls back like any other language.
    expect(langFromRequest(req("https://h.test/x?lang=mk"), { languages: ["en"] })).toBe("en");
  });

  it("has exactly the English keys, with matching placeholders", () => {
    expect(Object.keys(MKGUEST)).toEqual(Object.keys(ENGUEST));
    for (const k of Object.keys(ENGUEST)) expect(placeholders(MKGUEST[k]), k).toBe(placeholders(ENGUEST[k]));
  });

  it("translates and picks singular only for n === 1", () => {
    const tr = makeTranslator("mk");
    expect(tr.t("manageBooking")).not.toBe(ENGUEST.manageBooking);
    expect(tr.p("adult", 1)).not.toBe(tr.p("adult", 2));
    expect(tr.locale.code).toBe("mk");
  });

  it("words the EU order button in Macedonian", () => {
    expect(payButtonLabel("mk")).toBe("Резервирај со обврска за плаќање");
  });
});

describe("Macedonian admin language", () => {
  it("is offered, detected from Accept-Language, and served from the server registry", () => {
    expect(ADMIN_LANGS.some((l) => l.id === "mk")).toBe(true);
    expect(adminLangFromRequest(req("https://h.test/admin", { "Accept-Language": "mk-MK,mk;q=0.9" }))).toBe("mk");
    expect(adminLangFromRequest(req("https://h.test/admin", { Cookie: "admin_lang=mk" }))).toBe("mk");
    expect(adminDictFor("mk")).toBe(MKADMIN);
  });

  it("has exactly the English keys, with matching placeholders", () => {
    expect(Object.keys(MKADMIN)).toEqual(Object.keys(ENADMIN));
    for (const k of Object.keys(ENADMIN)) expect(placeholders(MKADMIN[k]), k).toBe(placeholders(ENADMIN[k]));
  });
});

describe("Macedonian denar", () => {
  it("is a supported property currency and formats with the ISO code", () => {
    expect(isSupportedCurrency("MKD")).toBe(true);
    expect(SUPPORTED_CURRENCIES.find(([c]) => c === "MKD")?.[1]).toBe("Macedonian Denar");
    // The denar has no symbol in the en-US display locale, so Intl gives the code.
    expect(formatMoney("5000.00", "MKD").replace(/\s/g, " ")).toBe("MKD 5,000.00");
  });
});
