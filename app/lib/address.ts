// Formatting a property's address for display. Pure — safe on the client.
//
// The parts live in two places: the street line is per-language free text on
// PropertyOverrides, and city / region / postcode / country are structured on
// SiteSettings (they feed Google's feeds). Anything showing an address to a
// guest needs both, so the assembly lives here rather than in each component —
// the map, contact and footer sections were all showing the street line alone.

import { COUNTRIES } from "./countries";

const COUNTRY_NAME = new Map(COUNTRIES.map((c) => [c.code, c.name]));

export interface AddressParts {
  /** Free-text street line, per language. */
  address?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2, e.g. "GB" — never shown as the code. */
  country?: string;
}

/**
 * A postal address as display lines, empty parts skipped.
 *
 * Region and postcode share a line, which is how most of the world writes it
 * ("Carmarthenshire SA31 1LQ", "TX 78701") and still reads correctly when only
 * one of the two is set. Ordering an address truly correctly is per-country and
 * not worth the rabbit hole; this never looks wrong.
 */
export function addressLines(parts: AddressParts): string[] {
  const clean = (v?: string) => v?.trim() ?? "";
  const street = clean(parts.address);
  const city = clean(parts.city);
  const regionLine = [clean(parts.region), clean(parts.postalCode)].filter(Boolean).join(" ");
  const country = clean(parts.country);

  // Plenty of hotels type the whole address into the one free-text box AND fill
  // the city field, which would print the city twice. Only drop it when the
  // street line's LAST comma-separated part IS the city — so
  // "123 King St, Carmarthen" loses the repeat, while "1 Carmarthen Road" in
  // some other town keeps its city line.
  const lastSegment = street.split(",").pop()?.trim().toLowerCase() ?? "";
  const cityIsRepeated = Boolean(city) && lastSegment === city.toLowerCase();

  return [
    street,
    cityIsRepeated ? "" : city,
    regionLine,
    // Show the country's name, never the two-letter code an admin picked from a
    // dropdown. An unknown code is dropped rather than printed raw.
    country ? (COUNTRY_NAME.get(country.toUpperCase()) ?? "") : "",
  ].filter(Boolean);
}

/** The same thing as one newline-joined string, for `whitespace-pre-line`. */
export function formatAddress(parts: AddressParts): string {
  return addressLines(parts).join("\n");
}

/** One-line form, for places with no room to breathe (meta tags, alt text). */
export function addressOneLine(parts: AddressParts): string {
  return addressLines(parts).join(", ");
}
