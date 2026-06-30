// Google feed readiness: what content a property still needs before Google will
// accept/process it in the Hotel List Feed + price structured data. Google drops
// listings (or rejects the whole feed) when required fields are missing, so we
// gate the feed on `requiredMissing` and surface the gaps in the admin.
import type { SiteSettings } from "./content";
import { getOverrides, getSettings, type PropertyOverrides } from "./overrides.server";

export interface ReadinessItem {
  field: string;
  /** Human label, with where to set it. */
  label: string;
}

export interface GoogleReadiness {
  /** True when no required content is missing — the property is fed to Google. */
  ready: boolean;
  /** Whether the property opted into Google structured data / the feed at all. */
  enabled: boolean;
  missingRequired: ReadinessItem[];
  missingRecommended: ReadinessItem[];
}

/** Required for Google to match + accept the listing. Pure so the feed builder
 *  and the admin readiness panel agree on exactly the same rule. */
export function requiredMissing(settings: SiteSettings, overrides: PropertyOverrides): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  const need = (ok: unknown, field: string, label: string) => {
    if (!ok) out.push({ field, label });
  };
  need(overrides.hotelName, "hotelName", "Hotel name (Property details)");
  need(overrides.address, "address", "Street (Location)");
  need(settings.addressCity, "addressCity", "City (Location)");
  need(settings.addressCountry, "addressCountry", "Country (Location)");
  need(settings.latitude && settings.longitude, "geo", "Map coordinates — latitude & longitude (Location)");
  // Google must not advertise a property that can't take a booking/payment.
  need(settings.stripeAccountId && settings.stripeChargesEnabled, "stripe", "Active Stripe connection (Payments)");
  return out;
}

/** Strongly recommended — improves matching/quality but won't block the feed. */
export function recommendedMissing(settings: SiteSettings, overrides: PropertyOverrides): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  const want = (ok: unknown, field: string, label: string) => {
    if (!ok) out.push({ field, label });
  };
  want(settings.addressRegion, "addressRegion", "Region / state (Location)");
  want(settings.addressPostalCode, "addressPostalCode", "Postal code (Location)");
  want(overrides.phone, "phone", "Phone (Property details)");
  want(settings.googleHotelId, "googleHotelId", "Google Hotel ID (set once matched in Hotel Center)");
  return out;
}

export async function checkGoogleReadiness(pid: string): Promise<GoogleReadiness> {
  const [settings, overrides] = await Promise.all([getSettings(pid), getOverrides(pid)]);
  return {
    enabled: settings.googleStructuredData !== false,
    missingRequired: requiredMissing(settings, overrides),
    missingRecommended: recommendedMissing(settings, overrides),
    ready: requiredMissing(settings, overrides).length === 0,
  };
}
