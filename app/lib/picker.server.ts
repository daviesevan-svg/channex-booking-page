// The shared domain's front door: "here is everything you can book".
//
// This used to be routes/home.tsx's loader. It moved out because "/" now means
// two different things depending on the hostname — the picker on
// book.roompanda.com, a hotel's own home page on their custom domain — and one
// route module has to be able to render either. Route matching cannot see the
// hostname, so the branch lives in the module rather than the route table.

import { getCollections } from "./collections.server";
import { getConfig } from "./config.server";
import { getOverrides, getSettings } from "./overrides.server";
import { getProperties, getProperty, getPublicProperties } from "./properties.server";

export interface PickerCard {
  href: string;
  name: string;
  /** Chip overlaid on the image (property type, or collection size). */
  tag: string;
  /** Small location / destination line above the name. */
  meta: string;
  blurb: string;
  cta: string;
  photo: string | null;
}

export interface PickerData {
  items: PickerCard[];
  subtitle: string;
  /** Heading brand: a white-label partner's name on THEIR guest host; unset =
   *  ours (the component's default). */
  brandName?: string;
}

/** First cover photo among a collection's member properties (checks a few, then
 *  gives up to a hatch placeholder). */
async function collectionPhoto(propertyIds: string[]): Promise<string | null> {
  for (const pid of propertyIds.slice(0, 4)) {
    const s = await getSettings(pid);
    if (s.coverImage) return s.coverImage;
  }
  return null;
}

function subtitle(n: number, kind: "collection" | "property"): string {
  if (kind === "collection") {
    return n === 1
      ? "Explore our collection and book direct — no booking fees."
      : `Explore ${n} collections and book direct — no booking fees.`;
  }
  return n === 1
    ? "Check availability and book direct — no booking fees."
    : `Browse ${n} places to stay and book direct — no booking fees.`;
}

/**
 * Cards for the picker. Throws a redirect on single-hotel deploys, where "/" is
 * the property itself rather than a list.
 */
/** A white-label partner's front door: their PUBLIC properties, their brand.
 *  No collections (a platform feature), no fall-through to our default
 *  property — an empty list renders as an empty picker rather than leaking a
 *  direct hotel onto the partner's domain. */
export async function loadPartnerPicker(partner: {
  id: string;
  brandName: string;
}): Promise<PickerData> {
  const properties = (await getProperties()).filter((p) => p.public && p.partnerId === partner.id);
  const items: PickerCard[] = await Promise.all(
    properties.map(async (p) => {
      const [settings, ov] = await Promise.all([getSettings(p.id), getOverrides(p.id)]);
      const area = [settings.addressCity, settings.addressRegion].filter(Boolean).join(", ");
      return {
        href: `/${p.slug || p.id}`,
        name: ov.hotelName || p.name,
        tag: ov.propertyType || (settings.singleUnit ? "Apartment" : "Hotel"),
        meta: area || settings.addressCountry || "",
        blurb: ov.description || "",
        cta: "Check availability →",
        photo: settings.coverImage || null,
      };
    }),
  );
  return { items, subtitle: subtitle(properties.length, "property"), brandName: partner.brandName };
}

export async function loadPicker(): Promise<PickerData> {
  // Prefer showcasing curated collections (owner-branded /c/:slug landings).
  // Skip empty ones — a collection with no properties isn't bookable.
  const collections = (await getCollections()).filter((c) => c.propertyIds.length > 0);
  if (collections.length > 0) {
    const items: PickerCard[] = await Promise.all(
      collections.map(async (c) => ({
        href: `/c/${c.slug}`,
        name: c.name,
        tag: `${c.propertyIds.length} ${c.propertyIds.length === 1 ? "stay" : "stays"}`,
        meta: c.destination || "",
        blurb: c.intro || "",
        cta: "Explore →",
        photo: await collectionPhoto(c.propertyIds),
      })),
    );
    return { items, subtitle: subtitle(collections.length, "collection") };
  }

  // No collections yet: fall back to showcasing individual public properties.
  const properties = await getPublicProperties();
  if (properties.length > 0) {
    const items: PickerCard[] = await Promise.all(
      properties.map(async (p) => {
        const [settings, ov] = await Promise.all([getSettings(p.id), getOverrides(p.id)]);
        const area = [settings.addressCity, settings.addressRegion].filter(Boolean).join(", ");
        return {
          href: `/${p.slug || p.id}`,
          name: ov.hotelName || p.name,
          tag: ov.propertyType || (settings.singleUnit ? "Apartment" : "Hotel"),
          meta: area || settings.addressCountry || "",
          blurb: ov.description || "",
          cta: "Check availability →",
          photo: settings.coverImage || null,
        };
      }),
    );
    return { items, subtitle: subtitle(properties.length, "property") };
  }

  // Nothing public: single-hotel deploys fall through to the default property;
  // otherwise show the setup hint.
  const { defaultPropertyId } = getConfig();
  if (defaultPropertyId && (await getProperty(defaultPropertyId))) {
    throw new Response(null, { status: 302, headers: { Location: `/${defaultPropertyId}` } });
  }
  return { items: [], subtitle: "" };
}
