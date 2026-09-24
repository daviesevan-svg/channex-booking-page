// Google feed readiness: what content a property still needs before Google will
// accept/process it in the Hotel List Feed + price structured data. Google drops
// listings (or rejects the whole feed) when required fields are missing, so we
// gate the feed on `requiredMissing` and surface the gaps in the admin.
import type { SiteSettings } from "./content";
import { getOverrides, getSettings, type PropertyOverrides } from "./overrides.server";
import { activeGateway } from "./payments.server";
import { getProperty } from "./properties.server";
import { hasReceivedAri } from "./ari/ingest.server";

/** Whether the property can actually take a booking — required before Google
 *  advertises it. Either a payment gateway we charge the guest through
 *  (Stripe with charges enabled, Viva, iyzico or 2C2P — whichever
 *  activeGateway resolves, the same lookup checkout uses), OR a live Channex
 *  connection where bookings push to Channex for payment/reservation.
 *  "Live" means Channex has actually sent an ARI push (not just that the
 *  connection was toggled on), so we never advertise a Channex property that
 *  isn't really trading. */
export async function canTakeBookings(pid: string, settings: SiteSettings): Promise<boolean> {
  if (settings.stripeAccountId && settings.stripeChargesEnabled) return true;
  // A Stripe account that can't charge yet still wins activeGateway, so
  // checkout would send the guest to it: that is not a way to book.
  const gateway = await activeGateway(pid, settings);
  if (gateway && gateway.kind !== "stripe") return true;
  if (settings.connectedSystem === "channex" && (await hasReceivedAri(pid))) return true;
  return false;
}

export interface ReadinessItem {
  field: string;
  /** Human label, with where to set it. */
  label: string;
}

export interface GoogleReadiness {
  /** True when no required content is missing — the property is fed to Google. */
  ready: boolean;
  missingRequired: ReadinessItem[];
  missingRecommended: ReadinessItem[];
}

/** Required for Google to match + accept the listing. Pure so the feed builder
 *  and the admin readiness panel agree on exactly the same rule. `canBook` is
 *  resolved by the caller via canTakeBookings(). */
export function requiredMissing(
  settings: SiteSettings,
  overrides: PropertyOverrides,
  canBook: boolean,
  isPublic: boolean,
): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  const need = (ok: unknown, field: string, label: string) => {
    if (!ok) out.push({ field, label });
  };
  // The feed only includes public properties — a private one is silently
  // dropped, so it's a hard requirement here too.
  need(isPublic, "public", "Make the property Public (Properties)");
  need(overrides.hotelName, "hotelName", "Hotel name (Property details)");
  need(overrides.address, "address", "Street (Location)");
  need(settings.addressCity, "addressCity", "City (Location)");
  need(settings.addressCountry, "addressCountry", "Country (Location)");
  need(settings.latitude && settings.longitude, "geo", "Map coordinates — latitude & longitude (Location)");
  // Google must not advertise a property that can't take a booking: a payment
  // gateway, or a live channel manager connection receiving rates.
  need(canBook, "payment", "A way to take bookings — connect a payment gateway: Stripe, Viva, iyzico or 2C2P (Payments), or a live channel manager connection receiving rates (Connectivity)");
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
  return out;
}

export async function checkGoogleReadiness(pid: string): Promise<GoogleReadiness> {
  const [settings, overrides, property] = await Promise.all([
    getSettings(pid),
    getOverrides(pid),
    getProperty(pid),
  ]);
  const canBook = await canTakeBookings(pid, settings);
  const missingRequired = requiredMissing(settings, overrides, canBook, Boolean(property?.public));
  return {
    missingRequired,
    missingRecommended: recommendedMissing(settings, overrides),
    ready: missingRequired.length === 0,
  };
}
