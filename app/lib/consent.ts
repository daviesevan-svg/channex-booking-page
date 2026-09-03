// The guest's consent choice: where it is stored, what it means, and who has to
// be asked. Pure — the cookie is parsed on the server (so the banner is in the
// first HTML, not a flash after hydration) and written in the browser.
//
// Two purposes, not five. Every extra toggle is a decision a guest has to make
// before they can book, and we only ever load two kinds of thing: something
// that counts visits and something that counts ads. A preference centre with
// six switches would be theatre.
import type { ConsentPosture } from "./content";

export const CONSENT_COOKIE = "rp_consent";

/**
 * Bump when the PURPOSES change — a new toggle, or an existing one starting to
 * cover something it didn't. Every stored choice below the current version is
 * treated as absent and the guest is asked again, which is the only honest
 * reading: they consented to the old set, not this one.
 */
export const CONSENT_VERSION = 1;

/** Six months. Long enough not to nag a returning guest, short enough that a
 *  choice made once doesn't stand for years. */
export const CONSENT_MAX_AGE_SEC = 180 * 24 * 60 * 60;

export interface ConsentChoice {
  /** Counting visits and funnel steps — GA4's `analytics_storage`. */
  analytics: boolean;
  /** Attributing a booking to an ad — `ad_storage`, `ad_user_data`,
   *  `ad_personalization`, and the click ID that makes them work. */
  ads: boolean;
  /** When it was made, epoch seconds. Kept because "prove when consent was
   *  given" is the whole point of recording it. */
  at: number;
  v: number;
}

/** `1.1725360000.1.0` — version, timestamp, analytics, ads. Deliberately not
 *  JSON: it goes in a cookie on every request, and this is 18 bytes. */
export function serializeConsent(c: Omit<ConsentChoice, "v">): string {
  return `${CONSENT_VERSION}.${Math.floor(c.at)}.${c.analytics ? 1 : 0}.${c.ads ? 1 : 0}`;
}

export function parseConsent(raw: string | undefined | null): ConsentChoice | null {
  if (!raw) return null;
  const [v, at, analytics, ads] = raw.split(".");
  if (Number(v) !== CONSENT_VERSION) return null;
  const ts = Number(at);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (analytics !== "0" && analytics !== "1") return null;
  if (ads !== "0" && ads !== "1") return null;
  return { v: CONSENT_VERSION, at: ts, analytics: analytics === "1", ads: ads === "1" };
}

export function consentFromCookies(header: string | null | undefined): ConsentChoice | null {
  const m = (header ?? "").match(new RegExp(`(?:^|;\\s*)${CONSENT_COOKIE}=([^;]+)`));
  return m ? parseConsent(decodeURIComponent(m[1])) : null;
}

/**
 * Where asking is required.
 *
 * EU + EEA (GDPR and the ePrivacy rules each state implements — in Germany
 * § 25 TDDDG), the UK (UK GDPR + PECR) and Switzerland (revFADP; consent is not
 * strictly demanded there, but every Swiss hotel's own site asks and a guest
 * who sees no banner reads it as us being sloppy).
 *
 * Deliberately its own list rather than shared with eu-consumer.ts: that one
 * answers "which contract law binds this hotel" about the PROPERTY, this one
 * answers "must this person be asked" about the VISITOR, and they will drift —
 * the UK is on this list and not on that one for exactly that reason.
 */
const ASK_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
  "SE", "IS", "LI", "NO", "GB", "CH",
]);

export function mustAskCountry(code: string | null | undefined): boolean {
  return Boolean(code) && ASK_COUNTRIES.has(String(code).trim().toUpperCase());
}

export interface ConsentGate {
  /** Show the banner. */
  ask: boolean;
  /** What the tags may do right now, before any answer. */
  granted: { analytics: boolean; ads: boolean };
}

/**
 * What a given request should do about consent.
 *
 * The visitor's country is not the only trigger: a German hotel is bound by
 * German rules for the site it operates, so it asks EVERY guest, while a
 * hotel outside the EEA asks only the guests who are inside it. One boolean OR,
 * and it is the difference between "correct" and "correct for the visitors we
 * happened to think of".
 *
 * An untagged property never asks. Nothing third-party loads there, so a banner
 * would be asking permission for something that isn't happening — which is both
 * pointless and, since it trains guests to click through banners, worse than
 * pointless.
 */
export function consentGate(input: {
  posture: ConsentPosture | undefined;
  tagged: boolean;
  /** Visitor country, from Cloudflare. */
  country: string | null | undefined;
  /** The property's own country (settings.addressCountry). */
  propertyCountry: string | undefined;
  stored: ConsentChoice | null;
}): ConsentGate {
  const { posture = "banner", tagged, country, propertyCountry, stored } = input;
  if (!tagged) return { ask: false, granted: { analytics: false, ads: false } };

  // The hotel runs its own CMP: we never draw a banner, and we start denied and
  // wait to be told otherwise. If their CMP is missing or misconfigured nothing
  // is ever measured — stated plainly in the admin copy, because the failure is
  // silent by nature.
  if (posture === "external") return { ask: false, granted: { analytics: false, ads: false } };

  // The hotel has chosen to fire everything. Their call, their risk, and the
  // admin copy says so in those words.
  if (posture === "off") return { ask: false, granted: { analytics: true, ads: true } };

  if (stored) return { ask: false, granted: { analytics: stored.analytics, ads: stored.ads } };

  const mustAsk = mustAskCountry(country) || mustAskCountry(propertyCountry);
  // Outside the asking countries an unanswered banner is not a legal problem,
  // so the tags the hotel configured simply work — the alternative is a hotel
  // in Thailand losing most of its measurement to a banner nobody required.
  return mustAsk ? { ask: true, granted: { analytics: false, ads: false } } : { ask: false, granted: { analytics: true, ads: true } };
}

/** Google Consent Mode v2 signals for a granted state. `ad_user_data` and
 *  `ad_personalization` ride with `ad_storage`: our single "advertising" toggle
 *  covers sending data to Google for ads, which is what all three gate. */
export function consentModeSignals(granted: { analytics: boolean; ads: boolean }): Record<string, "granted" | "denied"> {
  const ad = granted.ads ? "granted" : "denied";
  return {
    ad_storage: ad,
    ad_user_data: ad,
    ad_personalization: ad,
    analytics_storage: granted.analytics ? "granted" : "denied",
    // We store nothing on the device for these two, ever.
    functionality_storage: "denied",
    personalization_storage: "denied",
    security_storage: "granted",
  };
}
