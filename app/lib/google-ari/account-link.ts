// Google Ads ↔ Hotel Center account link — pure helpers + the stored record
// shape. Client-safe (no Workers imports); the API calls live in
// account-link.server.ts.

/** Google's AccountLinkStatus enum (plus anything an older client doesn't know). */
export type GoogleAdsLinkStatus =
  | "REQUESTED_FROM_HOTEL_CENTER"
  | "REQUESTED_FROM_GOOGLE_ADS"
  | "APPROVED"
  | (string & {});

/** What we remember about a property's link, stored in SiteSettings.googleAdsLink.
 *  Google does NOT return the Ads customer id on a link (only on create), so the
 *  customer id ↔ link-name pairing has to live on our side. */
export interface GoogleAdsLinkRecord {
  /** Normalised 10-digit Google Ads customer id (no dashes). */
  customerId: string;
  /** Google resource name: accounts/{hotelCenterAccount}/accountLinks/{id}. */
  name: string;
  /** Last status Google reported. */
  status: GoogleAdsLinkStatus;
  /** When the link was requested from our side (epoch ms). */
  createdAt: number;
  /** When `status` was last read from Google (epoch ms). */
  checkedAt: number;
}

export type GoogleAdsLinkState = "pending_ads" | "pending_hotel_center" | "approved" | "unknown";

/** Coarse state for the UI. */
export function linkStateOf(status: string): GoogleAdsLinkState {
  switch (status) {
    case "APPROVED":
      return "approved";
    case "REQUESTED_FROM_HOTEL_CENTER":
      return "pending_ads"; // we asked; the hotel approves in Google Ads
    case "REQUESTED_FROM_GOOGLE_ADS":
      return "pending_hotel_center"; // they asked; someone approves in Hotel Center
    default:
      return "unknown";
  }
}

/** "278-353-0096", "278 353 0096", "2783530096" → "2783530096"; anything that
 *  isn't exactly ten digits → null. Google Ads customer ids are always 10 digits. */
export function normalizeGoogleAdsCustomerId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

/** "2783530096" → "278-353-0096", the way Google Ads displays it. */
export function formatGoogleAdsCustomerId(id: string): string {
  return /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
}

/** Google match states in which the property is NOT on Google, so there is
 *  nothing an Ads account could bid on — the link is refused. `matched` passes;
 *  a never-checked (null) or unrecognised status passes too: the match check is
 *  best-effort and must never lock an owner out (same fail-open rule as the ARI
 *  push gate). Lives here (not in the .server module) because the admin page
 *  component uses it to hide the form — the action refuses the same states. */
export const NOT_ON_GOOGLE_STATES = ["not_found", "not_matched", "overlap"] as const;
export function blockedByMatchState(state: string | null | undefined): boolean {
  return (NOT_ON_GOOGLE_STATES as readonly string[]).includes(state ?? "");
}
