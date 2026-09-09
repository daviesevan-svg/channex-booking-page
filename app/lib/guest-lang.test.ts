import { describe, expect, it } from "vitest";

import { enabledLanguages, guestDefaultLang, langFromRequest, negotiateLang } from "./content";

// A German hotel with German guests greeted every one of them in English,
// because the guest default was the same constant as the base copy language.
// These pin the split: English stays the base (always enabled, the copy
// fallback); the guest default is the hotel's, and the browser's preference is
// honoured among the languages the hotel actually enabled.

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
const hotel = { languages: ["en", "de", "fr", "nl"], defaultLanguage: "de" };

describe("negotiateLang", () => {
  it("picks the highest-weighted enabled language, region tags stripped", () => {
    expect(negotiateLang("nl-BE;q=0.8, fr-CH, de;q=0.9", ["en", "de", "fr", "nl"])).toBe("fr");
    expect(negotiateLang("de-AT", ["en", "de"])).toBe("de");
  });
  it("is undefined when the browser lists nothing on offer", () => {
    expect(negotiateLang("ja, zh;q=0.9", ["en", "de"])).toBeUndefined();
    expect(negotiateLang("*", ["en", "de"])).toBeUndefined();
    expect(negotiateLang(null, ["en"])).toBeUndefined();
  });
});

describe("guestDefaultLang / enabledLanguages", () => {
  it("is the hotel's choice when enabled, English otherwise", () => {
    expect(guestDefaultLang(hotel)).toBe("de");
    expect(guestDefaultLang({ languages: ["en"], defaultLanguage: "de" })).toBe("de"); // the default is auto-enabled
    expect(enabledLanguages({ languages: ["en"], defaultLanguage: "de" })).toEqual(["en", "de"]);
    expect(guestDefaultLang({ languages: ["en", "fr"], defaultLanguage: "xx" })).toBe("en");
    expect(guestDefaultLang({})).toBe("en");
  });
});

describe("langFromRequest", () => {
  it("?lang wins, but only among the hotel's enabled languages", () => {
    expect(langFromRequest(req("https://h.test/x?lang=fr"), hotel)).toBe("fr");
    // Spanish is supported by the platform but not enabled by this hotel.
    expect(langFromRequest(req("https://h.test/x?lang=es"), hotel)).toBe("de");
  });
  it("then the sticky cookie", () => {
    expect(langFromRequest(req("https://h.test/x", { Cookie: "a=1; ibe_lang=nl" }), hotel)).toBe("nl");
    expect(langFromRequest(req("https://h.test/x", { Cookie: "ibe_lang=es" }), hotel)).toBe("de");
  });
  it("then Accept-Language among the enabled languages", () => {
    expect(langFromRequest(req("https://h.test/x", { "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" }), hotel)).toBe("fr");
    expect(langFromRequest(req("https://h.test/x", { "Accept-Language": "es-ES,es;q=0.9" }), hotel)).toBe("de");
  });
  it("then the hotel's default — no longer hardcoded English", () => {
    expect(langFromRequest(req("https://h.test/x"), hotel)).toBe("de");
    expect(langFromRequest(req("https://h.test/x"), { languages: ["en", "de"] })).toBe("en");
  });
  it("without settings (no property) behaves as before, plus negotiation", () => {
    expect(langFromRequest(req("https://h.test/x"))).toBe("en");
    expect(langFromRequest(req("https://h.test/x?lang=es"))).toBe("es");
    expect(langFromRequest(req("https://h.test/x", { "Accept-Language": "it" }))).toBe("it");
  });
});

describe("validatePropertyPatch default_language", async () => {
  const { validatePropertyPatch } = await import("./manage-validate");
  const stored = { languages: ["en", "de"] };
  it("accepts an enabled language and stores it", () => {
    const r = validatePropertyPatch({ default_language: "de" }, stored);
    expect(r.ok && r.value.defaultLanguage).toBe("de");
  });
  it("rejects a language the hotel has not enabled, unless the same patch enables it", () => {
    const bad = validatePropertyPatch({ default_language: "fr" }, stored);
    expect(bad.ok).toBe(false);
    const both = validatePropertyPatch({ languages: ["en", "fr"], default_language: "fr" }, stored);
    expect(both.ok && both.value.defaultLanguage).toBe("fr");
  });
  it("rejects an unknown code; null and en both clear the field", () => {
    expect(validatePropertyPatch({ default_language: "xx" }, stored).ok).toBe(false);
    const cleared = validatePropertyPatch({ default_language: null }, stored);
    expect(cleared.ok && cleared.value.defaultLanguage).toBeNull();
    const en = validatePropertyPatch({ default_language: "en" }, stored);
    expect(en.ok && en.value.defaultLanguage).toBeNull();
  });
});
