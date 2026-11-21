import { describe, expect, it } from "vitest";

import { makeTranslator } from "./i18n";
import { DATE_PATTERNS, MONEY_STYLES } from "./locale-format";
import { LOCALE_COPY } from "./locales/copy";
import { formatMoney, formatMoneyParts } from "./money";

const nb = (s: string) => s.replace(/\u00a0/g, " "); // read NBSPs as spaces in expectations

describe("money per guest language", () => {
  it("English is en-US output, unchanged", () => {
    expect(formatMoney(1083.6, "GBP")).toBe("£1,083.60");
    expect(formatMoney(1083.6, "EUR", "en")).toBe("€1,083.60");
    expect(formatMoney(20000, "JPY", "en")).toBe("¥20,000");
    expect(formatMoney(54, "CHF", "en")).toBe(new Intl.NumberFormat("en-US", { style: "currency", currency: "CHF" }).format(54));
  });

  it.each([
    ["sk", 54, "EUR", "54,00 €"],
    ["sk", 1083.6, "EUR", "1 083,60 €"],
    ["cs", 1083.6, "CZK", "1 083,60 CZK"],
    ["pl", 1083.6, "PLN", "1083,60 PLN"],
    ["pl", 10830, "EUR", "10 830,00 €"],
    ["de", 1083.6, "EUR", "1.083,60 €"],
    ["fr", 1083.6, "EUR", "1 083,60 €"],
    ["es", 1083.6, "EUR", "1083,60 €"],
    ["es", 12345.5, "EUR", "12.345,50 €"],
    ["it", 1083.6, "EUR", "1.083,60 €"],
    ["pt", 1083.6, "EUR", "1083,60 €"],
    ["nl", 1083.6, "EUR", "€ 1.083,60"],
    ["tr", 1083.6, "TRY", "₺1.083,60"],
    ["tr", 54, "CHF", "CHF 54,00"],
    ["th", 1083.6, "THB", "฿1,083.60"],
    ["de", 20000, "JPY", "20.000 ¥"],
    ["de", 1234567.891, "KWD", "1.234.567,891 KWD"],
    ["sk", -5, "EUR", "-5,00 €"],
  ])("%s %s %s → %s", (lang, amount, currency, out) => {
    expect(nb(formatMoney(amount, currency, lang))).toBe(out);
  });

  it("an unknown language formats as English", () => {
    expect(formatMoney(1083.6, "EUR", "xx")).toBe("€1,083.60");
  });

  it("the parts reassemble to the formatted price, and `value` is machine-readable", () => {
    for (const lang of Object.keys(MONEY_STYLES)) {
      const p = formatMoneyParts(1083.6, "EUR", lang);
      expect(p.before + p.number + p.after).toBe(formatMoney(1083.6, "EUR", lang));
      expect(p.value).toBe("1083.60");
    }
    expect(formatMoneyParts(1083.6, "EUR", "sk")).toMatchObject({ before: "", number: "1\u00a0083,60", after: "\u00a0€" });
  });

  it("a Channex price string works the same as a number", () => {
    expect(nb(formatMoney("198.00", "EUR", "sk"))).toBe("198,00 €");
  });
});

describe("dates per guest language", () => {
  const sk = makeTranslator("sk");
  const en = makeTranslator("en");

  it("Slovak writes the day with a full stop and the month as a number", () => {
    expect(sk.dateRange("2026-12-14", "2026-12-16")).toBe("po 14. – st 16. 12.");
    expect(sk.date("2026-12-14", "long")).toBe("14. 12. 2026");
    expect(sk.date("2026-12-01", "month")).toBe("december 2026"); // the heading form, not "decembra"
  });

  it("English keeps its shapes", () => {
    expect(en.dateRange("2026-12-14", "2026-12-16")).toBe("Mon 14 – Wed 16 Dec");
    expect(en.date("2026-12-14", "dayYear")).toBe("Mon 14 Dec 2026");
    expect(en.date("2026-12-01", "month")).toBe("December 2026");
  });

  it("a range across months names both months, and across years both years", () => {
    expect(en.dateRange("2026-11-30", "2026-12-02")).toBe("Mon 30 Nov – Wed 2 Dec");
    expect(en.dateRange("2026-12-30", "2027-01-02", { year: true })).toBe("Wed 30 Dec 2026 – Sat 2 Jan 2027");
    expect(sk.dateRange("2026-11-30", "2026-12-02")).toBe("po 30. 11. – st 2. 12.");
  });

  it("German, Polish and Turkish use their own order", () => {
    expect(makeTranslator("de").dateRange("2026-12-14", "2026-12-16")).toBe("Mo., 14. – Mi., 16. Dez.");
    expect(makeTranslator("pl").date("2026-12-01", "month")).toBe("grudzień 2026");
    expect(makeTranslator("tr").date("2026-12-14", "day")).toBe("14 Ara Pzt");
  });

  it("the translator's money is the language's money", () => {
    expect(nb(sk.money(54, "EUR"))).toBe("54,00 €");
    expect(en.money(54, "EUR")).toBe("€54.00");
  });
});

describe("every guest language has a format", () => {
  it.each(Object.keys(LOCALE_COPY))("%s has money and date entries", (lang) => {
    expect(MONEY_STYLES[lang], `add ${lang} to MONEY_STYLES in locale-format.ts`).toBeDefined();
    expect(DATE_PATTERNS[lang], `add ${lang} to DATE_PATTERNS in locale-format.ts`).toBeDefined();
  });
});
