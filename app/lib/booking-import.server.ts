// Import a property's CONTENT from its public Booking.com listing, for
// onboarding. One scrape per import, reviewed by the owner before anything is
// written — deliberately the opposite shape from the deleted price scraper
// (PR#305): nothing here runs on a schedule, feeds a guest-facing claim, or can
// be silently wrong without a human looking at it first.
//
// What the page gives us (verified live against booking.com/hotel/gb/spilman,
// 2026-08-12): a `<script data-capla-store-data="apollo" type="application/json">`
// blob — the page's GraphQL cache — carrying the property record (name, city,
// coordinates, address), star rating, the hotel description, check-in/out time
// ranges, the full facilities list, the photo gallery, and one RoomDetails
// record per room type (name, description, size, bed configuration, occupancy,
// photos) INCLUDING rooms sold out for the fetched date. A dated URL is used
// anyway so the availability table exists as a cross-check that the page is a
// real hotel page and not a bot challenge.
//
// Booking's WAF challenge comes back as upstream 202 with ~2 KB of HTML and
// Scrapfly still reports success — the PR#305 false-sold-out trap. Every parse
// therefore begins with authenticity guards, and the wizard surfaces failures
// loudly; the owner falls back to manual setup, nothing is half-written.
import { addDays, format } from "date-fns";

import { saveFacilitiesExtra, saveHeroImage, saveOverrides, patchSettings } from "./overrides.server";
import { replaceRooms, type CatalogRoom } from "./catalog.server";
import { addImages } from "./gallery.server";
import { importImageFromUrl } from "./images.server";
import { isSupportedCurrency } from "./currencies";
import { addProperty } from "./properties.server";
import { getUser } from "./users.server";
import { DEFAULT_LANG } from "./content";
import { scrapeUrl } from "./scrapfly.server";

// ---- payload types (also what the wizard round-trips through the form) ----

export interface BookingImportRoom {
  /** Booking's room id — only used to key checkboxes in the wizard. */
  ref: string;
  name: string;
  description?: string;
  sizeM2?: number;
  /** Humanized bed summary, e.g. "1 king-size bed". */
  beds?: string;
  maxGuests: number;
  bathroomCount?: number;
  /** Absolute cf.bstatic.com URLs (max1024 variants), capped. */
  photos: string[];
}

export interface BookingImport {
  name: string;
  description?: string;
  address: string;
  city?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2, lowercase as Booking stores it. */
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  starRating?: number;
  checkinFrom?: string;
  checkoutUntil?: string;
  /** Best-guess property currency from the hotel's country — the wizard shows
   *  it in a select for the owner to confirm; it is never trusted blind. */
  currency?: string;
  facilities: string[];
  /** Property-level gallery photos (absolute URLs), capped. */
  photos: string[];
  rooms: BookingImportRoom[];
  sourceUrl: string;
}

const GALLERY_PHOTO_CAP = 24; // MAX_GALLERY_IMAGES is 40; leave the owner room
const ROOM_PHOTO_CAP = 8;

// ---- URL handling ----

/** Normalize a pasted Booking.com listing URL to the en-gb page with dates ~3
 *  weeks out (a dated page carries the availability table we use as an
 *  authenticity cross-check; room CONTENT comes from the cache and does not
 *  depend on the dates). Returns null for anything that isn't a Booking.com
 *  hotel page — the wizard refuses rather than scraping an arbitrary URL. */
export function normalizeBookingUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)booking\.com$/.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/hotel\/([a-z]{2})\/([a-z0-9-]+?)(?:\.[a-z]{2}(?:-[a-z]{2})?)?\.html$/i);
  if (!m) return null;
  const checkin = format(addDays(new Date(), 21), "yyyy-MM-dd");
  const checkout = format(addDays(new Date(), 22), "yyyy-MM-dd");
  return `https://www.booking.com/hotel/${m[1].toLowerCase()}/${m[2].toLowerCase()}.en-gb.html?checkin=${checkin}&checkout=${checkout}&group_adults=2&no_rooms=1`;
}

// ---- parsing ----

/** True when the HTML really is a Booking hotel page. The WAF challenge is a
 *  few KB with none of these markers, and must never be parsed as content. */
function isBookingHotelPage(html: string): boolean {
  return html.includes("hp_hotel_name") || html.includes("b_hotel_id");
}

type CacheRecord = Record<string, unknown>;

/** The page's embedded Apollo cache: plain JSON in a marked script tag. */
function extractApolloCache(html: string): Record<string, CacheRecord> | null {
  const at = html.indexOf('data-capla-store-data="apollo"');
  if (at < 0) return null;
  const tagEnd = html.indexOf(">", at);
  const close = html.indexOf("</script>", tagEnd);
  if (tagEnd < 0 || close < 0) return null;
  try {
    const parsed = JSON.parse(html.slice(tagEnd + 1, close));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, CacheRecord>) : null;
  } catch {
    return null;
  }
}

const records = (cache: Record<string, CacheRecord>, type: string): CacheRecord[] =>
  Object.entries(cache)
    .filter(([k]) => k.startsWith(`${type}:`))
    .map(([, v]) => v);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Resolve `{__ref: "Key:..."}` pointers against the cache. */
const deref = (cache: Record<string, CacheRecord>, v: unknown): CacheRecord | undefined => {
  const ref = (v as { __ref?: string } | undefined)?.__ref;
  return ref ? cache[ref] : undefined;
};

/** A photo URI (relative or absolute) as an absolute max1024 URL. Booking's
 *  size variant is a path segment (`/max200/`, `/square60/`), so any variant
 *  can be rewritten to the large one — the `k` token stays valid. */
function photoUrl(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const abs = uri.startsWith("http") ? uri : `https://cf.bstatic.com${uri}`;
  return abs.replace(/\/(?:max|square|thumb)[^/]*\//, "/max1024x768/");
}

const BED_NAMES: Record<string, string> = {
  SINGLE_BED: "single bed",
  DOUBLE_BED: "double bed",
  LARGE_DOUBLE_BED: "king-size bed",
  EXTRA_LARGE_DOUBLE_BED: "super-king bed",
  SOFA_BED: "sofa bed",
  BUNK_BED: "bunk bed",
  FUTON: "futon",
};

/** "1 king-size bed" / "2 single beds and 1 sofa bed" from the first (primary)
 *  bed configuration. Unknown enum values humanize as lowercased words. */
function bedSummary(config: unknown): string | undefined {
  const beds = ((config as { beds?: unknown[] } | undefined)?.beds ?? []) as {
    bedType?: string;
    count?: number;
  }[];
  const parts = beds
    .filter((b) => b.bedType && (b.count ?? 0) > 0)
    .map((b) => {
      const name = BED_NAMES[b.bedType!] ?? b.bedType!.toLowerCase().replace(/_/g, " ");
      const plural = b.count === 1 ? name : `${name}s`;
      return `${b.count} ${plural}`;
    });
  return parts.length ? parts.join(" and ") : undefined;
}

/** Deep-walk the cache for the check-in/out ranges. They live today at
 *  Property.houseRules.checkinCheckoutTimes, but that path has churned before —
 *  match the field shape wherever it sits, and give up quietly (the times are a
 *  nice-to-have; General has defaults). */
function findTimeRanges(value: unknown, depth = 0): { checkin?: string; checkout?: string } {
  if (!value || typeof value !== "object" || depth > 6) return {};
  const rec = value as {
    checkinTimeRange?: { fromFormatted?: string };
    checkoutTimeRange?: { untilFormatted?: string };
  };
  if (rec.checkinTimeRange || rec.checkoutTimeRange) {
    return {
      checkin: str(rec.checkinTimeRange?.fromFormatted),
      checkout: str(rec.checkoutTimeRange?.untilFormatted),
    };
  }
  for (const v of Object.values(rec)) {
    const found = findTimeRanges(v, depth + 1);
    if (found.checkin || found.checkout) return found;
  }
  return {};
}

/** Default property currency for a hotel's country — a REVIEW-STEP DEFAULT the
 *  owner confirms, never a silent decision. Countries not listed default to
 *  EUR/USD-free blank so the owner must pick. */
const CURRENCY_BY_COUNTRY: Record<string, string> = {
  gb: "GBP", ie: "EUR", fr: "EUR", de: "EUR", es: "EUR", pt: "EUR", it: "EUR", nl: "EUR",
  be: "EUR", at: "EUR", gr: "EUR", fi: "EUR", ee: "EUR", lv: "EUR", lt: "EUR", sk: "EUR",
  si: "EUR", hr: "EUR", cy: "EUR", mt: "EUR", lu: "EUR", bg: "EUR",
  us: "USD", ca: "CAD", au: "AUD", nz: "NZD", ch: "CHF", jp: "JPY", th: "THB", tr: "TRY",
  se: "SEK", no: "NOK", dk: "DKK", pl: "PLN", cz: "CZK", hu: "HUF", ro: "RON", is: "ISK",
  mx: "MXN", br: "BRL", za: "ZAR", ae: "AED", sg: "SGD", hk: "HKD", in: "INR", id: "IDR",
  my: "MYR", ph: "PHP", vn: "VND", kr: "KRW", cn: "CNY", eg: "EGP", ma: "MAD", ke: "KES",
};

/** Parse a fetched Booking.com hotel page into an import payload, or a loud
 *  error naming what was wrong — never a half-filled result. */
export function parseBookingListing(html: string, sourceUrl: string): BookingImport | { error: string } {
  if (!isBookingHotelPage(html)) {
    return { error: "That page doesn't look like a Booking.com hotel page (it may be an anti-bot challenge — try again, or check the URL opens the hotel's own listing)." };
  }
  const cache = extractApolloCache(html);
  if (!cache) return { error: "Couldn't find the listing data on the page. Booking.com may have changed their page format — import manually for now." };

  const basic = records(cache, "BasicPropertyData")[0];
  const name = str((basic as { name?: unknown } | undefined)?.name);
  if (!basic || !name) return { error: "The listing data is missing the property record. Booking.com may have changed their page format — import manually for now." };

  const location = (basic.location ?? {}) as CacheRecord;
  const translation = records(cache, "HotelTranslation")[0];
  const star = records(cache, "StarRating")[0];
  const times = findTimeRanges(cache);

  // JSON-LD fills the gaps the cache doesn't carry (postcode).
  let postalCode: string | undefined;
  const ld = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (ld) {
    try {
      const parsed = JSON.parse(ld[1]) as { address?: { postalCode?: string } };
      postalCode = str(parsed.address?.postalCode);
    } catch {
      /* optional */
    }
  }

  // Facilities: BaseFacility instances carry their display title inside the
  // Instance ref key itself — `Instance:{"id":15,"title":"Iron"}`.
  const facilities: string[] = [];
  for (const f of records(cache, "BaseFacility")) {
    for (const inst of (f.instances ?? []) as unknown[]) {
      const ref = (inst as { __ref?: string }).__ref;
      const m = ref?.match(/^Instance:(\{.*\})$/);
      if (!m) continue;
      try {
        const title = str((JSON.parse(m[1]) as { title?: string }).title);
        if (title && !facilities.includes(title)) facilities.push(title);
      } catch {
        /* skip one facility, not the import */
      }
    }
  }

  // Property gallery: every non-room AccommodationPhoto, largest variant.
  const photos: string[] = [];
  for (const p of records(cache, "AccommodationPhoto")) {
    if (p.photoType === "ROOM") continue;
    const variant = Object.entries(p).find(([k]) => k.startsWith("resource("));
    const url = photoUrl(str((variant?.[1] as { relativeUrl?: string } | undefined)?.relativeUrl));
    if (url && !photos.includes(url)) photos.push(url);
    if (photos.length >= GALLERY_PHOTO_CAP) break;
  }

  // Rooms: RoomDetails has every room type on the property, including ones
  // sold out for the fetched dates.
  const rooms: BookingImportRoom[] = [];
  for (const r of records(cache, "RoomDetails")) {
    const ref = num(r.id) ?? str(r.id);
    const tr = (r.translations ?? {}) as { name?: unknown; description?: unknown };
    const roomName = str(tr.name);
    if (ref === undefined || !roomName) continue;
    const occupancy = (r.occupancy ?? {}) as { maxPersons?: unknown; maxGuests?: unknown };
    const roomPhotos: string[] = [];
    for (const pref of (r.roomPhotos ?? []) as unknown[]) {
      const photo = deref(cache, pref);
      const url = photoUrl(str((photo as { photoUri?: string } | undefined)?.photoUri));
      if (url && !roomPhotos.includes(url)) roomPhotos.push(url);
      if (roomPhotos.length >= ROOM_PHOTO_CAP) break;
    }
    rooms.push({
      ref: String(ref),
      name: roomName,
      description: str(tr.description),
      sizeM2: num(r.roomSizeM2),
      beds: bedSummary(((r.bedConfigurations ?? []) as unknown[])[0]),
      maxGuests: num(occupancy.maxPersons) ?? num(occupancy.maxGuests) ?? 2,
      bathroomCount: num(r.bathroomCount),
      photos: roomPhotos,
    });
  }
  if (rooms.length === 0) {
    return { error: "No rooms were found on the listing. Booking.com may have changed their page format — import manually for now." };
  }

  const countryCode = str(location.countryCode)?.toLowerCase();
  const guessedCurrency = countryCode ? CURRENCY_BY_COUNTRY[countryCode] : undefined;
  return {
    name,
    description: str((translation as { description?: unknown } | undefined)?.description),
    address: str(location.formattedAddress) ?? str(location.formattedAddressShort) ?? "",
    city: str(location.city),
    postalCode,
    countryCode,
    latitude: num(location.latitude),
    longitude: num(location.longitude),
    starRating: num((star as { value?: unknown } | undefined)?.value),
    checkinFrom: times.checkin,
    checkoutUntil: times.checkout,
    currency: guessedCurrency && isSupportedCurrency(guessedCurrency) ? guessedCurrency : undefined,
    facilities,
    photos,
    rooms,
    sourceUrl,
  };
}

/** Fetch + parse a Booking.com listing. Residential proxy is required — the
 *  datacenter pool gets Booking's WAF challenge (202) on hotel pages now, not
 *  just search (verified 2026-08-12; ~25–30 credits per fetch). */
export async function fetchBookingListing(normalizedUrl: string): Promise<BookingImport | { error: string }> {
  const res = await scrapeUrl(normalizedUrl, {
    asp: true,
    country: "gb",
    proxyPool: "public_residential_pool",
    timeoutMs: 90_000,
  });
  if (!res.ok || !res.content) {
    return { error: res.error ? `Couldn't fetch the listing: ${res.error}` : "Couldn't fetch the listing." };
  }
  return parseBookingListing(res.content, normalizedUrl);
}

// ---- import (writes) ----

export interface BookingImportSelection {
  /** Room refs to import. */
  roomRefs: Set<string>;
  importPhotos: boolean;
  importFacilities: boolean;
  /** Owner-confirmed currency (validated against SUPPORTED_CURRENCIES). */
  currency?: string;
}

/** Fetch an image from Booking's CDN and stash it in R2. A single failed image
 *  never fails the import — the room just has fewer photos, which the owner
 *  sees on the very next screen. */
async function importPhoto(prefix: string, url: string): Promise<string | null> {
  try {
    return await importImageFromUrl(prefix, url);
  } catch {
    return null;
  }
}

/** Small concurrency cap: ~80 image fetches in flight at once would trip
 *  subrequest and memory limits; 6 at a time keeps the import a few seconds. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Create the local property from a reviewed payload. Returns the new pid. */
export async function importBookingListing(
  owner: string,
  payload: BookingImport,
  sel: BookingImportSelection,
): Promise<string> {
  const pid = crypto.randomUUID();
  const partnerId = (await getUser(owner))?.partnerId;
  await addProperty(pid, payload.name, owner, partnerId);

  await saveOverrides(pid, DEFAULT_LANG, {
    hotelName: payload.name,
    address: payload.address,
    description: payload.description ?? "",
  });
  await patchSettings(pid, {
    addressCity: payload.city,
    addressCountry: payload.countryCode?.toUpperCase(),
    addressPostalCode: payload.postalCode,
    latitude: payload.latitude !== undefined ? String(payload.latitude) : undefined,
    longitude: payload.longitude !== undefined ? String(payload.longitude) : undefined,
    checkinTime: payload.checkinFrom,
    checkoutTime: payload.checkoutUntil,
    currency: sel.currency && isSupportedCurrency(sel.currency) ? sel.currency : undefined,
  });

  if (sel.importFacilities && payload.facilities.length) {
    await saveFacilitiesExtra(pid, DEFAULT_LANG, payload.facilities);
  }

  if (sel.importPhotos && payload.photos.length) {
    const urls = (await mapLimit(payload.photos, 6, (u) => importPhoto(`home/${pid}`, u))).filter(
      (u): u is string => Boolean(u),
    );
    if (urls.length) {
      await addImages(pid, urls);
      await saveHeroImage(pid, urls[0]);
    }
  }

  const rooms = payload.rooms.filter((r) => sel.roomRefs.has(r.ref));
  const now = new Date().toISOString();
  const catalogRooms: CatalogRoom[] = [];
  for (const [position, r] of rooms.entries()) {
    const images = sel.importPhotos
      ? (await mapLimit(r.photos, 6, (u) => importPhoto(`rooms/${pid}/${r.ref}`, u))).filter(
          (u): u is string => Boolean(u),
        )
      : [];
    // Bed setup and size arrive as facility lines — free text the owner can
    // edit or delete, shown to guests as-is (CatalogRoom.facilities).
    const facilities = [
      r.beds,
      r.sizeM2 ? `${Math.round(r.sizeM2)} m²` : undefined,
      r.bathroomCount && r.bathroomCount > 1 ? `${r.bathroomCount} bathrooms` : undefined,
    ].filter((f): f is string => Boolean(f));
    catalogRooms.push({
      id: crypto.randomUUID(),
      title: r.name,
      description: r.description,
      images,
      maxAdults: r.maxGuests,
      maxGuests: r.maxGuests,
      facilities,
      position,
      createdAt: now,
    });
  }
  await replaceRooms(pid, catalogRooms);
  return pid;
}
