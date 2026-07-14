// Google Vacation Rentals list feed.
// https://developers.google.com/hotels/vacation-rentals/dev-guide/vr-attributes
//
// One XML file listing every property whose Google program is "vacation_rentals",
// so Google can ingest each VR listing's static content and match it before ARI
// prices attach. Distinct from the Hotel List Feed (hotel-list-feed.server): the
// VR feed carries the VR-required attributes (capacity + website) and each listing
// is a single unit. Built from the property registry + settings/overrides; served
// (short cache) from a public resource route for Google's scheduled pull.
import { getConfig } from "./config.server";
import { getRooms } from "./catalog.server";
import { VR_AMENITY_ENUMS, VR_AMENITY_KEYS, type SiteSettings } from "./content";
import { checkGoogleReadiness } from "./google-readiness.server";
import { GOOGLE_HOTEL_BRAND } from "./hotel-list-feed.server";
import { getOverrides, getSettings } from "./overrides.server";
import { getProperties } from "./properties.server";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `<component name="…">value</component>`, omitted when the value is empty. */
function component(name: string, value?: string): string {
  const v = (value ?? "").trim();
  return v ? `        <component name="${name}">${esc(v)}</component>\n` : "";
}

function tag(name: string, value?: string): string {
  const v = (value ?? "").trim();
  return v ? `    <${name}>${esc(v)}</${name}>\n` : "";
}

/** The public booking URL for a property — the landing page Google's "Book" link
 *  points at. Uses the slug when set, else the id, on the configured app origin. */
function propertyUrl(idOrSlug: string): string {
  const origin = getConfig().appUrl.replace(/\/+$/, "");
  return `${origin}/${idOrSlug}`;
}

/** Absolute URL for an uploaded image path (/images/… → https://host/images/…).
 *  Already-absolute URLs are returned unchanged. Empty when there's no source. */
function absImage(src: string | undefined): string {
  const s = (src ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const origin = getConfig().appUrl.replace(/\/+$/, "");
  return `${origin}${s.startsWith("/") ? "" : "/"}${s}`;
}

/** `<client_attr name="k">v</client_attr>`, omitted when empty. */
function clientAttr(name: string, value?: string): string {
  const v = (value ?? "").trim();
  return v ? `        <client_attr name="${name}">${esc(v)}</client_attr>\n` : "";
}

/** Google VR amenity client_attr lines from the property's structured amenities
 *  (set in the admin). Booleans in `vrAmenities` (restricted to the known
 *  vocabulary) are sent as "Yes"; enum selections in `vrAmenityOptions` are sent
 *  as-is. Free-text room facilities are intentionally NOT used here — Google only
 *  accepts its fixed vocabulary. */
function amenityAttrs(settings: SiteSettings, unitAmenities: string[] = []): string {
  const lines: string[] = [];
  // Unit size — Google requires these before a VR listing goes live. 0 is valid
  // (a studio has 0 bedrooms), so emit whenever a non-negative number is set.
  const num = (name: string, v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? lines.push(clientAttr(name, String(v))) : 0;
  num("number_of_bedrooms", settings.vrBedrooms);
  num("number_of_bathrooms", settings.vrBathrooms);
  num("number_of_beds", settings.vrBeds);
  // Property-wide amenities ∪ the unit's own (deduped) — the VR listing IS the
  // unit, so what the room offers belongs on the listing too.
  for (const key of new Set([...(settings.vrAmenities ?? []), ...unitAmenities])) {
    if (VR_AMENITY_KEYS.has(key)) lines.push(clientAttr(key, "Yes"));
  }
  const enums = settings.vrAmenityOptions ?? {};
  for (const def of VR_AMENITY_ENUMS) {
    const v = enums[def.key];
    if (v && def.options.includes(v)) lines.push(clientAttr(def.key, v));
  }
  return lines.join("");
}

/** `<image>` elements (inside <content>) for a set of image URLs, titled with the
 *  property name. Absolute-ised and deduped; empty sources skipped. */
function imageElements(sources: (string | undefined)[], title: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    const url = absImage(src);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(
      `      <image type="photo" url="${esc(url)}">\n` +
        `        <link>${esc(url)}</link>\n` +
        (title ? `        <title>${esc(title)}</title>\n` : "") +
        `      </image>\n`,
    );
  }
  return out.join("");
}

/** The `<listing>` elements for every public, ready, vacation-rental property
 *  (no `<listings>` wrapper) — reused both by our own VR feed and by the merged
 *  Channex+us VR feed. Empty string when there's nothing to advertise. */
export async function vrListingElements(): Promise<string> {
  const properties = await getProperties();
  const listings: string[] = [];

  for (const p of properties) {
    if (!p.public) continue;
    const settings = await getSettings(p.id);
    // Only vacation-rental properties belong in this feed.
    if (settings.googleProgram !== "vacation_rentals") continue;
    // Skip properties missing data Google requires — an incomplete listing can
    // get the whole feed rejected. Same required set as the Hotel List Feed
    // (name/address/country/geo/bookable); VR adds capacity + website below,
    // both of which we always have (capacity from the unit, website derived).
    const readiness = await checkGoogleReadiness(p.id);
    if (!readiness.ready) continue;

    const [overrides, rooms] = await Promise.all([getOverrides(p.id), getRooms(p.id)]);
    // A VR listing is a single unit — take the first room for its capacity.
    const unit = rooms[0];
    if (!unit) continue;

    const name = overrides.hotelName || p.name;
    const address =
      component("addr1", overrides.address) +
      component("city", settings.addressCity) +
      component("province", settings.addressRegion) +
      component("postal_code", settings.addressPostalCode);
    const website = propertyUrl(p.slug || p.id);
    // As much content as we hold — Google builds & showcases the listing from
    // this feed. Photos from the unit (+ the property cover); amenities mapped
    // from the unit's facilities; description + instant-book flag.
    const images = imageElements([...unit.images, settings.coverImage], name);
    const attrs =
      `        <website>${esc(website)}</website>\n` +
      clientAttr("capacity", String(unit.maxGuests)) +
      // hotel_brand → lets a Google POS <Match brand="…"> route our listings to
      // our own booking pages (same mechanism as the Hotel List Feed), so a
      // merged feed sends ours to us and Channex's rest to Channex.
      clientAttr("hotel_brand", GOOGLE_HOTEL_BRAND) +
      // We confirm bookings instantly (Stripe or a live Channex connection).
      clientAttr("instant_bookable", "Yes") +
      clientAttr("description", overrides.description || unit.description) +
      amenityAttrs(settings, unit.amenities ?? []);

    listings.push(
      `  <listing>\n` +
        tag("id", p.id) +
        tag("name", name) +
        (address ? `    <address format="simple">\n${address}    </address>\n` : "") +
        tag("country", settings.addressCountry) +
        tag("latitude", settings.latitude) +
        tag("longitude", settings.longitude) +
        (overrides.phone ? `    <phone type="main">${esc(overrides.phone)}</phone>\n` : "") +
        // Free-text per Google ("use whatever property type categories you wish").
        tag("category", overrides.propertyType || "vacation_rental") +
        `    <content>\n${images}      <attributes>\n${attrs}      </attributes>\n    </content>\n` +
        `  </listing>`,
    );
  }

  return listings.join("\n");
}

/** Build the standalone VR list feed XML (our properties only). Empty
 *  `<listings>` when there are none (a valid feed Google accepts). */
export async function buildVrListFeed(): Promise<string> {
  const listings = await vrListingElements();
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<listings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n` +
    `    xsi:noNamespaceSchemaLocation="http://www.gstatic.com/localfeed/local_feed.xsd">\n` +
    `  <language>en</language>\n` +
    (listings.trim() ? listings + "\n" : "") +
    `</listings>\n`
  );
}
