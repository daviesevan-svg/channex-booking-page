// Everything the presentational sections need, loaded for whichever sections a
// page actually has.
//
// Shared by the home page and the extra pages so a section behaves the same
// wherever it's placed — the alternative is each route assembling its own props
// and the two slowly disagreeing about, say, whether the contact form shows.
//
// Loading is conditional on section type: a page with no reviews section never
// touches D1, and a page with no rooms section never reads the catalog.

import { formatAddress } from "./address";
import { getRooms } from "./catalog.server";
import { getConfig } from "./config.server";
import { normalizeFacilities } from "./content";
import { todayISODate } from "./dates";
import { getGalleryFor } from "./gallery.server";
import { getFacilitiesExtra, getOverrides, getSearchContent, getSettings } from "./overrides.server";
import { getPublicOffers } from "./promotions.server";
import { getPublicReviews } from "./reviews.server";
import { getActiveVoucherProducts } from "./vouchers.server";
import type { SectionData } from "./section-data";
import type { SectionType } from "./sections";

type Settings = Awaited<ReturnType<typeof getSettings>>;

const NO_REVIEWS = { average: 0, count: 0, reviews: [] };

export async function loadSectionData(
  pid: string,
  lang: string,
  sections: { type: SectionType }[],
  settings: Settings,
  /** The home page already loads its hero image; pass it rather than re-reading. */
  fallbackPhoto?: string,
): Promise<SectionData> {
  const has = (type: SectionType) => sections.some((s) => s.type === type);

  const lat = parseFloat(settings.latitude ?? "");
  const lng = parseFloat(settings.longitude ?? "");
  // No coordinates, no map — a location section pointing at 0,0 in the Atlantic
  // is worse than no location section.
  const wantsMap = has("map") && Number.isFinite(lat) && Number.isFinite(lng);
  const wantsContact = has("contact");
  // The street line is per-language free text; city / region / postcode /
  // country are structured on settings. Both sections need the whole thing.
  const wantsAddress = wantsMap || wantsContact;

  const [rooms, offers, gallery, facilitiesExtra, reviews, hasVouchers, overrides, heroPhoto] =
    await Promise.all([
      has("rooms") ? getRooms(pid).catch(() => []) : Promise.resolve([]),
      // Already fails open to an empty list, so no .catch() here.
      has("offers") ? getPublicOffers(pid) : Promise.resolve([]),
      has("gallery") ? getGalleryFor(pid, lang).catch(() => []) : Promise.resolve([]),
      // Fail open throughout: a data hiccup in one section must not take the
      // whole page down with it.
      has("facilities") ? getFacilitiesExtra(pid, lang).catch(() => []) : Promise.resolve([]),
      has("reviews") ? getPublicReviews(pid).catch(() => NO_REVIEWS) : Promise.resolve(NO_REVIEWS),
      has("vouchers")
        ? getActiveVoucherProducts(pid)
            .then((v) => v.length > 0)
            .catch(() => false)
        : Promise.resolve(false),
      wantsAddress || wantsContact ? getOverrides(pid, lang) : Promise.resolve(null),
      // Only the gallery falls back to the hero image, and only when the caller
      // hasn't already got it.
      has("gallery") && fallbackPhoto === undefined
        ? getSearchContent(pid, lang)
            .then((c) => c.heroImage)
            .catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

  const fullAddress = wantsAddress
    ? formatAddress({
        address: overrides?.address,
        city: settings.addressCity,
        region: settings.addressRegion,
        postalCode: settings.addressPostalCode,
        country: settings.addressCountry,
      })
    : "";

  return {
    rooms: rooms.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      photo: r.images[0],
      maxGuests: r.maxGuests,
    })),
    offers,
    gallery,
    // Normalized here so an unknown key can never reach the page and render as
    // a raw slug; free-text lines are shown as typed.
    facilities: has("facilities") ? normalizeFacilities(settings.facilities ?? []) : [],
    facilitiesExtra,
    reviews,
    hasVouchers,
    map: wantsMap
      ? { lat, lng, mapKey: getConfig().googleMapKey ?? "", address: fullAddress || undefined }
      : null,
    contact: {
      address: fullAddress || undefined,
      phone: overrides?.phone,
      email: overrides?.email,
      checkinTime: settings.checkinTime,
      checkoutTime: settings.checkoutTime,
      canReceive: Boolean(settings.hostNotifyEmail || settings.emailReplyTo || overrides?.email),
    },
    fallbackPhoto: fallbackPhoto ?? heroPhoto ?? undefined,
    today: todayISODate(),
  };
}
