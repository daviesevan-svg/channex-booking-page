import { describe, expect, it } from "vitest";

import { LANGUAGES, pageDefaults, searchDefaults } from "./content";
import { emailDefaults } from "./email-defaults.server";
import { makeTranslator, pluralForm } from "./i18n";
import { DATE_LOCALES } from "./locales/date-locales";
import { GUEST_DICTS } from "./locales/dicts.server";
import { LOCALE_COPY } from "./locales/copy";
import { LOCALE_EMAILS } from "./locales/emails.server";
import EN from "./locales/en";
import "./i18n-locales.server";

// Every guest language is data written by `npm run i18n:import` and wired up by
// the generated registries (scripts/i18n.mjs). These guard the hand-offs.

const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(" ");
const langs = Object.keys(LOCALE_COPY);

describe("guest language registries", () => {
  it("every language has a dictionary, emails, a date locale and a picker entry", () => {
    expect(Object.keys(GUEST_DICTS).sort()).toEqual(["en", ...langs].sort());
    expect(Object.keys(LOCALE_EMAILS).sort()).toEqual([...langs].sort());
    for (const l of ["en", ...langs]) expect(DATE_LOCALES[l], l).toBeDefined();
    expect(LANGUAGES.map((l) => l.code)).toEqual(["en", ...langs]);
    for (const l of LANGUAGES) expect(l.label && l.flag, l.code).toBeTruthy();
  });
});

describe("translations keep English's {placeholders}", () => {
  it.each(langs)("%s", (lang) => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(GUEST_DICTS[lang])) {
      const enKey = EN[k] != null ? k : k.replace(/_(zero|two|few|many)$/, "_other");
      if (EN[enKey] == null) bad.push(`ui.${k}: not an English key`);
      else if (ph(v) !== ph(EN[enKey])) bad.push(`ui.${k}`);
    }
    const copy = LOCALE_COPY[lang];
    for (const [k, v] of Object.entries(copy.search ?? {})) if (ph(v) !== ph(searchDefaults("en")[k as "heading"] as string)) bad.push(`search.${k}`);
    for (const [p, fields] of Object.entries(copy.pages ?? {})) {
      const en = pageDefaults(p, "en");
      for (const [k, v] of Object.entries(fields)) if (en[k] == null || ph(v) !== ph(en[k])) bad.push(`page.${p}.${k}`);
    }
    for (const [id, fields] of Object.entries(LOCALE_EMAILS[lang])) {
      const en = emailDefaults(id, "en");
      for (const [k, v] of Object.entries(fields)) if (en[k] == null || ph(v) !== ph(en[k])) bad.push(`email.${id}.${k}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("plural forms", () => {
  it("is _one only for 1, and never turns another count singular", () => {
    expect([0, 1, 2, 21].map((n) => pluralForm("en", n))).toEqual(["other", "one", "other", "other"]);
    expect(pluralForm("fr", 0)).toBe("other"); // CLDR says "one"; the dictionaries were written for "other"
  });

  it("gives Slovak and Czech their 2–4 form", () => {
    for (const l of ["sk", "cs"]) expect([1, 2, 4, 5, 0].map((n) => pluralForm(l, n))).toEqual(["one", "few", "few", "other", "other"]);
  });

  it("falls back to _other when a language has no key for its form", () => {
    // German has only _one/_other; Intl never asks it for more, and an unknown tag behaves like English.
    expect(makeTranslator("de").p("adult", 3)).toBe(makeTranslator("de").p("adult", 5).replace("5", "3"));
  });
});

describe("Slovak and Czech", () => {
  it("count with three forms: 1 / 2–4 / 5+", () => {
    const sk = makeTranslator("sk");
    expect([1, 2, 5].map((n) => sk.p("night", n))).toEqual(["1 noc", "2 noci", "5 nocí"]);
    expect([1, 3, 5].map((n) => sk.p("adult", n))).toEqual(["1 dospelý", "3 dospelí", "5 dospelých"]);
    const cs = makeTranslator("cs");
    expect([1, 2, 5].map((n) => cs.p("night", n))).toEqual(["1 noc", "2 noci", "5 nocí"]);
    expect([1, 4, 5].map((n) => cs.p("child", n))).toEqual(["1 dítě", "4 děti", "5 dětí"]);
  });

  it("are offered with their own names, date locales and EU order button", async () => {
    const { payButtonLabel } = await import("./eu-consumer");
    expect(LANGUAGES.find((l) => l.code === "sk")?.label).toBe("Slovenčina");
    expect(LANGUAGES.find((l) => l.code === "cs")?.label).toBe("Čeština");
    expect(makeTranslator("sk").locale.code).toBe("sk");
    expect(makeTranslator("cs").locale.code).toBe("cs");
    expect(payButtonLabel("sk")).toBe("Rezervovať s povinnosťou platby");
    expect(payButtonLabel("cs")).toBe("Rezervovat s povinností platby");
  });

  it("translate every English key, the page defaults and all five guest emails", () => {
    for (const l of ["sk", "cs"]) {
      for (const k of Object.keys(EN)) expect(GUEST_DICTS[l][k], `${l} ${k}`).toBeTruthy();
      expect(Object.keys(LOCALE_EMAILS[l]).sort()).toEqual(
        ["booking_cancellation", "booking_confirmation", "booking_failed", "booking_failed_refund_pending", "review_request"],
      );
      expect(Object.keys(LOCALE_COPY[l].pages ?? {}).sort()).toEqual(["checkout", "confirmation", "detail", "extras", "results"]);
    }
  });
});
