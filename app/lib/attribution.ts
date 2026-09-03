// Where a booking came from: the click ID and campaign parameters on the URL
// the guest first landed on.
//
// The awkward bit, and the reason this is its own module: a gclid is
// unrecoverable if not taken at landing, and NOT storable before the guest
// agrees to advertising. Storing it on the device is exactly what § 25 TDDDG
// governs, and a click ID is not "strictly necessary" for booking a room by any
// reading.
//
// So it is held in memory from the moment the page loads, and only written down
// once advertising consent exists. A guest who accepts on the landing page — the
// overwhelming majority — is captured perfectly. One who accepts three steps
// later is still captured, because a client-side navigation never discards the
// module. One who reloads the page before accepting is lost, and that is the
// honest cost of not writing to their device before being allowed to.
import { clickAttribution, type ClickAttribution } from "./tracking";

export const ATTRIBUTION_COOKIE = "rp_src";
/** 90 days: longer than any booking window we care about attributing, shorter
 *  than Google Ads' own 90-day maximum click lookback, so it can never outlive
 *  the thing it exists to match against. */
export const ATTRIBUTION_MAX_AGE_SEC = 90 * 24 * 60 * 60;

/** Compact, because it rides on every request once written. */
export function serializeAttribution(a: ClickAttribution): string {
  return JSON.stringify(a);
}

export function parseAttribution(raw: string | undefined | null): ClickAttribution {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Re-run it through the same filter that produced it: this value came off
    // the guest's own device and can have been edited there.
    return clickAttribution(new URLSearchParams(Object.entries(parsed as Record<string, string>)));
  } catch {
    return {};
  }
}

export function attributionFromCookies(header: string | null | undefined): ClickAttribution {
  const m = (header ?? "").match(new RegExp(`(?:^|;\\s*)${ATTRIBUTION_COOKIE}=([^;]+)`));
  return m ? parseAttribution(decodeURIComponent(m[1])) : {};
}

export function hasAttribution(a: ClickAttribution): boolean {
  return Object.keys(a).length > 0;
}
