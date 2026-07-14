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
import { checkGoogleReadiness } from "./google-readiness.server";
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

/** Build the VR list feed XML for every public, ready, vacation-rental property.
 *  Empty `<listings>` when there are none (a valid feed Google accepts). */
export async function buildVrListFeed(): Promise<string> {
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
    const attrs =
      `      <website>${esc(website)}</website>\n` +
      `      <client_attr name="capacity">${unit.maxGuests}</client_attr>\n`;

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
        (overrides.description ? tag("description", overrides.description) : "") +
        `    <content>\n      <attributes>\n${attrs}      </attributes>\n    </content>\n` +
        `  </listing>`,
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<listings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n` +
    `    xsi:noNamespaceSchemaLocation="http://www.gstatic.com/localfeed/local_feed.xsd">\n` +
    `  <language>en</language>\n` +
    (listings.length ? listings.join("\n") + "\n" : "") +
    `</listings>\n`
  );
}
