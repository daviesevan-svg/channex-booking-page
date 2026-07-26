// The directory a collection operator browses to find properties to add.
//
// An operator here is looking at properties they do NOT own, so what this
// exposes is deliberately narrow:
//
//   Shown  — name, town/region/country, property type, hero photo, public
//            description, and the trading signal (see property-activity).
//            All of that is already public on the property's own booking page,
//            so listing it here discloses nothing new.
//   Hidden — bookings, revenue, guest data, and *rates and availability by
//            date*. A searchable, filterable view of many properties' live
//            prices is a rate-shopping tool, and building one pointed at our
//            own customers would be a bad thing to do by accident.
//   Never  — contact details. The operator presses Invite and the platform
//            carries it. Handing over email addresses would turn the directory
//            into a lead list and properties would opt out en masse.
import { getHeroImage, getOverrides, getSettings } from "./overrides.server";
import { getProperties, type PropertyRef } from "./properties.server";
import { propertyActivity } from "./property-activity.server";
import type { PropertyActivity } from "./property-activity";

export interface DirectoryEntry {
  id: string;
  name: string;
  /** "Carmarthen, Wales, GB" — as much as is set, never a street address. */
  location: string;
  /** "Boutique hotel", "Apartment" — the label already shown on collection pages. */
  propertyType?: string;
  country?: string;
  photo?: string;
  activity: PropertyActivity | null;
}

export interface DirectoryQuery {
  /** Free text over name and location. */
  q?: string;
  /** ISO-3166 alpha-2, matched case-insensitively. */
  country?: string;
  /** Ids to leave out — normally the collection's current and past members, so
   *  the operator isn't offered someone they've already added or been refused
   *  by. */
  exclude?: Set<string>;
  limit?: number;
}

const DEFAULT_LIMIT = 24;

/** Listed properties only. Unset means listed (opt-out), so a property that has
 *  never touched the setting is discoverable. */
export function isListed(p: PropertyRef): boolean {
  return p.directoryListed !== false;
}

const locationOf = (s: { addressCity?: string; addressRegion?: string; addressCountry?: string }): string =>
  [s.addressCity, s.addressRegion, s.addressCountry].map((x) => x?.trim()).filter(Boolean).join(", ");

export async function browseDirectory(query: DirectoryQuery = {}): Promise<DirectoryEntry[]> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const needle = query.q?.trim().toLowerCase();
  const country = query.country?.trim().toUpperCase();

  const candidates = (await getProperties()).filter(
    (p) => isListed(p) && !query.exclude?.has(p.id),
  );

  // Resolve display fields first, then filter — city/region live in settings, so
  // a location search can't be done against the registry alone.
  const resolved = await Promise.all(
    candidates.map(async (p) => {
      const [ov, settings, photo] = await Promise.all([
        getOverrides(p.id),
        getSettings(p.id),
        getHeroImage(p.id).catch(() => undefined),
      ]);
      return {
        id: p.id,
        name: ov.hotelName || p.name,
        location: locationOf(settings),
        propertyType: ov.propertyType?.trim() || undefined,
        country: settings.addressCountry?.trim().toUpperCase() || undefined,
        photo: photo || undefined,
      };
    }),
  );

  const matched = resolved
    .filter((e) => (country ? e.country === country : true))
    .filter((e) => (needle ? `${e.name} ${e.location}`.toLowerCase().includes(needle) : true))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);

  // Only for the page being shown — the trading signal is the expensive part.
  const activity = await propertyActivity(matched.map((e) => e.id));
  return matched.map((e) => ({ ...e, activity: activity.get(e.id) ?? null }));
}
