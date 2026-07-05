// Google Hotel List Feed (HLF).
// https://developers.google.com/hotels/hotel-prices/dev-guide/hlf
//
// One XML file listing every hotel we want Google to know about, with the
// identifier (matching the price-feed / structured-data id), name, structured
// address + geo, so Google can match each property to its listing. Built from
// the property registry + per-property settings/overrides; served (uncached to
// Google's pull) from a public resource route.
import { getOverrides, getSettings } from "./overrides.server";
import { getProperties } from "./properties.server";
import { requiredMissing } from "./google-readiness.server";

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
  return v ? `      <component name="${name}">${esc(v)}</component>\n` : "";
}

function tag(name: string, value?: string): string {
  const v = (value ?? "").trim();
  return v ? `    <${name}>${esc(v)}</${name}>\n` : "";
}

/** The `<listing>` elements for all public, structured-data-enabled properties
 *  (no `<listings>` wrapper) — reused both by our own feed and by the merged
 *  Channex+us feed. Empty string when we have nothing to advertise. */
export async function googleListingElements(): Promise<string> {
  const properties = await getProperties();
  const listings: string[] = [];

  for (const p of properties) {
    // Only properties opted into the public listing AND not opted out of the
    // Google structured data are advertised to Google.
    if (!p.public) continue;
    const [settings, overrides] = await Promise.all([getSettings(p.id), getOverrides(p.id)]);
    if (settings.googleStructuredData === false) continue;
    // Skip properties missing data Google requires — an incomplete listing can
    // get the whole feed rejected. The admin readiness panel flags these.
    if (requiredMissing(settings, overrides).length > 0) continue;

    const id = p.id;
    const name = overrides.hotelName || p.name;
    const address =
      component("addr1", overrides.address) +
      component("city", settings.addressCity) +
      component("province", settings.addressRegion) +
      component("postal_code", settings.addressPostalCode);

    const hasGeo = settings.latitude && settings.longitude;
    listings.push(
      `  <listing>\n` +
        tag("id", id) +
        tag("name", name) +
        (address ? `    <address format="simple">\n${address}    </address>\n` : "") +
        tag("country", settings.addressCountry) +
        (hasGeo ? tag("latitude", settings.latitude) + tag("longitude", settings.longitude) : "") +
        (overrides.phone ? `    <phone type="main">${esc(overrides.phone)}</phone>\n` : "") +
        `    <category>hotel</category>\n` +
        `  </listing>`,
    );
  }

  return listings.join("\n");
}

/** Build the HLF XML for all public, structured-data-enabled properties. */
export async function buildHotelListFeed(): Promise<string> {
  const listings = await googleListingElements();
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<listings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n` +
    `    xsi:noNamespaceSchemaLocation="http://www.gstatic.com/localfeed/local_feed.xsd">\n` +
    `  <language>en</language>\n` +
    (listings ? listings + "\n" : "") +
    `</listings>\n`
  );
}
