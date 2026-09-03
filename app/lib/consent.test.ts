import { describe, expect, it } from "vitest";

import {
  CONSENT_VERSION,
  consentFromCookies,
  consentGate,
  consentModeSignals,
  parseConsent,
  serializeConsent,
} from "./consent";

const stored = (analytics: boolean, ads: boolean) => ({ v: CONSENT_VERSION, at: 1_725_360_000, analytics, ads });

describe("the stored choice", () => {
  it("round-trips", () => {
    const raw = serializeConsent({ analytics: true, ads: false, at: 1_725_360_000 });
    expect(raw).toBe(`${CONSENT_VERSION}.1725360000.1.0`);
    expect(parseConsent(raw)).toEqual(stored(true, false));
  });

  it("reads it out of a cookie header alongside others", () => {
    const raw = serializeConsent({ analytics: false, ads: true, at: 1_725_360_000 });
    expect(consentFromCookies(`ibe_lang=de; rp_consent=${raw}; other=x`)).toEqual(stored(false, true));
  });

  it("treats an older version as no answer at all — they agreed to the old purposes", () => {
    expect(parseConsent(`0.1725360000.1.1`)).toBeNull();
  });

  it("refuses anything malformed rather than guessing a permissive default", () => {
    for (const raw of ["", "garbage", "1.notatime.1.1", `${CONSENT_VERSION}.1725360000.yes.no`, `${CONSENT_VERSION}.0.1.1`]) {
      expect(parseConsent(raw), raw).toBeNull();
    }
    expect(consentFromCookies(null)).toBeNull();
  });
});

describe("who gets asked", () => {
  const base = { posture: "banner" as const, tagged: true, stored: null, propertyCountry: "GB", country: "US" };

  it("asks a visitor in an asking country", () => {
    expect(consentGate({ ...base, country: "DE" }).ask).toBe(true);
    expect(consentGate({ ...base, country: "GB" }).ask).toBe(true);
    expect(consentGate({ ...base, country: "CH" }).ask).toBe(true);
  });

  it("asks EVERY visitor of a property inside the EEA, wherever they are", () => {
    expect(consentGate({ ...base, propertyCountry: "DE", country: "US" }).ask).toBe(true);
    expect(consentGate({ ...base, propertyCountry: "DE", country: null }).ask).toBe(true);
  });

  it("leaves a non-EEA hotel's non-EEA visitors alone, and their tags working", () => {
    const gate = consentGate({ ...base, propertyCountry: "TH", country: "US" });
    expect(gate.ask).toBe(false);
    expect(gate.granted).toEqual({ analytics: true, ads: true });
  });

  it("never asks for an untagged property — nothing is happening to consent to", () => {
    const gate = consentGate({ ...base, tagged: false, country: "DE", propertyCountry: "DE" });
    expect(gate.ask).toBe(false);
    expect(gate.granted).toEqual({ analytics: false, ads: false });
  });

  it("honours a stored answer instead of asking again", () => {
    const gate = consentGate({ ...base, country: "DE", stored: stored(true, false) });
    expect(gate.ask).toBe(false);
    expect(gate.granted).toEqual({ analytics: true, ads: false });
  });

  it("with an external CMP: no banner of ours, and denied until it says otherwise", () => {
    const gate = consentGate({ ...base, posture: "external", country: "DE" });
    expect(gate.ask).toBe(false);
    expect(gate.granted).toEqual({ analytics: false, ads: false });
  });

  it("with consent management off: everything fires, which is the hotel's decision", () => {
    const gate = consentGate({ ...base, posture: "off", country: "DE", propertyCountry: "DE" });
    expect(gate.ask).toBe(false);
    expect(gate.granted).toEqual({ analytics: true, ads: true });
  });

  it("defaults a missing posture to asking — the safe one wins when nothing was chosen", () => {
    expect(consentGate({ ...base, posture: undefined, country: "DE" }).ask).toBe(true);
  });
});

describe("Consent Mode signals", () => {
  it("moves all three advertising signals together", () => {
    const s = consentModeSignals({ analytics: true, ads: false });
    expect(s.ad_storage).toBe("denied");
    expect(s.ad_user_data).toBe("denied");
    expect(s.ad_personalization).toBe("denied");
    expect(s.analytics_storage).toBe("granted");
  });

  it("never claims storage we don't use", () => {
    const s = consentModeSignals({ analytics: true, ads: true });
    expect(s.functionality_storage).toBe("denied");
    expect(s.personalization_storage).toBe("denied");
  });
});
