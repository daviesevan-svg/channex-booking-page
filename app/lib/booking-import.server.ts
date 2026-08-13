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
// real hotel page and not a bot challenge — and, since 2026-08-13, because the
// bookable offers are what the rate plans are derived from (see parseRatePlans).
//
// Booking's WAF challenge comes back as upstream 202 with ~2 KB of HTML and
// Scrapfly still reports success — the PR#305 false-sold-out trap. Every parse
// therefore begins with authenticity guards, and the wizard surfaces failures
// loudly; the owner falls back to manual setup, nothing is half-written.
import { addDays, format } from "date-fns";

import { saveFacilitiesExtra, saveHeroImage, saveOverrides, patchSettings } from "./overrides.server";
import { replaceRates, replaceRooms, type CatalogRate, type CatalogRoom } from "./catalog.server";
import { addImages } from "./gallery.server";
import { importImageFromUrl } from "./images.server";
import { isSupportedCurrency } from "./currencies";
import { addProperty } from "./properties.server";
import { getUser } from "./users.server";
import { DEFAULT_LANG, type DeadlineUnit } from "./content";
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

export interface BookingImportRate {
  /** Booking's rate id plus the meal/policy discriminators that split it — only
   *  used to key checkboxes in the wizard. */
  ref: string;
  /** Descriptive name built from the meal plan and cancellation policy. Booking
   *  never publishes a hotel's own rate-plan names (see parseRatePlans). */
  name: string;
  /** Meal-plan label for CatalogRate.mealPlan; absent means room only. */
  mealPlan?: string;
  refundable: boolean;
  /** Free-cancellation window, when Booking states one as an offset from
   *  arrival ("until 2 days before arrival"). */
  cancelDeadlineValue?: number;
  cancelDeadlineUnit?: DeadlineUnit;
  /** Booking's own cancellation sentence, kept only when no window could be
   *  read from it — see parseRatePlans. */
  cancellationNote?: string;
  /** Booking's prepayment wording ("No prepayment needed – pay at the
   *  property"). Shown on the review screen; never written to the rate, whose
   *  payment terms are the owner's own decision, not the OTA's. */
  prepayment?: string;
  /** How many of the listing's room types offer this rate — review-screen
   *  context only (no price is imported, so no room is priced on it). */
  roomCount: number;
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
  /** Rate plans derived from the bookable offers. Empty when the listing had no
   *  offers for the fetched dates (a sold-out hotel) — the import still runs. */
  rates: BookingImportRate[];
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

// ---- rate plans ----
//
// Booking never publishes a hotel's own rate-plan names: the room table
// describes every bookable offer by its meal plan and its cancellation and
// prepayment terms, and that is all a guest (or we) can see. So a rate plan here
// is one distinct (Booking rate id, meal plan, cancellation, prepayment)
// combination, named from what the listing says about it. The set of plans is
// the useful part — a hotel selling "room only, non-refundable" and "breakfast,
// flexible" recognises those two immediately and renames them to their own
// wording in the rate editor.
//
// Source (verified live against booking.com/hotel/gb/spilman and
// /gb/cumberlandhotellondon, 2026-08-13): the same Apollo cache the content
// comes from, under ROOT_QUERY's `roomDetail(…)` field — `offers(…)` carries one
// RDSOffer per bookable block (blockId `roomId_rateId_occupancy_mealplanId_…`,
// a mealplan enum and the room it belongs to), and `policiesTranslations(…)`
// carries one policy record per offer, linked by the offer's `scopedId`. The
// legacy `b_rooms_available_and_soldout` blob in the page carries the same
// meal/cancellation facts, but only as ids and only on the older page variant.
//
// Offers exist only for rooms that are bookable on the fetched dates, so a
// sold-out listing yields no rate plans. That degrades quietly (the wizard says
// so) rather than failing the whole import, which is content-led.

/** An Apollo field whose key carries serialized GraphQL arguments —
 *  `offers({"roomDetailQueryInput":…})`. Matched by prefix so a change in the
 *  query variables (dates, occupancy) doesn't break the lookup. */
function argField(node: unknown, name: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  const hit = Object.entries(node as CacheRecord).find(([k]) => k === name || k.startsWith(`${name}(`));
  return hit?.[1];
}

interface RdsOffer {
  scopedId?: string;
  productDescriptor?: {
    blockId?: string;
    mealplan?: string;
    roomStay?: { roomId?: number };
  };
}

interface PolicyCopy {
  policyTypeKey?: string;
  title?: { tagTranslation?: string };
  description?: { tagTranslation?: string };
  parameters?: { hasCancellationFee?: number } | null;
}

interface OfferCopy {
  key?: string;
  cancellationDetails?: PolicyCopy | null;
  prepaymentDetails?: PolicyCopy | null;
}

/** Booking's mealplan enum as a label for CatalogRate.mealPlan. Room-only maps
 *  to undefined — the rate list already renders that as "Room only". Unknown
 *  values humanize (SOFT_ALL_INCLUSIVE → "Soft all inclusive") rather than being
 *  dropped: a clumsy label the owner edits beats losing the distinction. */
const MEAL_PLANS: Record<string, string | undefined> = {
  NONE: undefined,
  BREAKFAST_EXCLUDED: undefined,
  ROOM_ONLY: undefined,
  BREAKFAST: "Breakfast included",
  BREAKFAST_LUNCH: "Breakfast & lunch included",
  BREAKFAST_DINNER: "Breakfast & dinner included",
  HALF_BOARD: "Half board",
  FULL_BOARD: "Full board",
  ALL_INCLUSIVE: "All inclusive",
  LUNCH: "Lunch included",
  DINNER: "Dinner included",
  BREAKFAST_LUNCH_DINNER: "Breakfast, lunch & dinner included",
};

function mealPlanLabel(enumValue: string | undefined): string | undefined {
  if (!enumValue) return undefined;
  if (enumValue in MEAL_PLANS) return MEAL_PLANS[enumValue];
  const words = enumValue.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Booking's policy copy comes as HTML fragments ("<b>Free cancellation</b>
 *  before 2 September 2026"). We only ever store the plain text. */
function tagText(copy: PolicyCopy["title"] | undefined): string | undefined {
  return str(copy?.tagTranslation?.replace(/<[^>]*>/g, ""));
}

/** "You may cancel free of charge until 2 days before arrival." → 2 days. The
 *  page is fetched as en-gb so the wording is deterministic; any other phrasing
 *  (an absolute date, a tiered policy) yields undefined and the sentence itself
 *  is kept instead — see parseRatePlans. */
function freeCancelWindow(description: string | undefined): { value: number; unit: DeadlineUnit } | undefined {
  const m = description?.match(/free of charge until (\d+) (day|days|hour|hours) before arrival/i);
  if (!m) return undefined;
  return { value: Number(m[1]), unit: m[2].toLowerCase().startsWith("day") ? "days" : "hours" };
}

function parseRatePlans(cache: Record<string, CacheRecord>): BookingImportRate[] {
  const roomDetail = argField(cache.ROOT_QUERY, "roomDetail");
  const offers = (argField(roomDetail, "offers") ?? []) as RdsOffer[];
  if (!Array.isArray(offers)) return [];
  const policies = argField(roomDetail, "policiesTranslations") as
    | { policyDisplayOutput?: { offerCopyDetailsList?: OfferCopy[] } }
    | undefined;
  const copyByOffer = new Map(
    (policies?.policyDisplayOutput?.offerCopyDetailsList ?? []).map((c) => [str(c.key), c]),
  );

  interface Group extends BookingImportRate {
    /** Rooms this rate was offered on — counted, not stored (no price is
     *  imported, so a room can't be attached to the rate yet). */
    rooms: Set<number>;
  }
  const groups = new Map<string, Group>();
  for (const offer of offers) {
    const descriptor = offer?.productDescriptor;
    // `roomId_rateId_occupancy_mealplanId_…` — the rate id is what a hotel would
    // call a rate plan; the rest of the block id varies per party size.
    const rateId = str(descriptor?.blockId)?.split("_")[1];
    if (!rateId) continue;

    const copy = copyByOffer.get(str(offer.scopedId));
    const cancel = copy?.cancellationDetails ?? undefined;
    const prepay = copy?.prepaymentDetails ?? undefined;
    const mealEnum = str(descriptor?.mealplan);
    const key = [rateId, mealEnum ?? "", str(cancel?.policyTypeKey) ?? "", str(prepay?.policyTypeKey) ?? ""].join("|");

    const existing = groups.get(key);
    if (existing) {
      const roomId = num(descriptor?.roomStay?.roomId);
      if (roomId !== undefined) existing.rooms.add(roomId);
      continue;
    }

    // `hasCancellationFee` is the structured signal; the policy key is the
    // readable one. Anything we don't recognise counts as non-refundable — the
    // conservative reading, and the review screen shows Booking's own sentence
    // next to it either way.
    const refundable =
      cancel?.parameters?.hasCancellationFee === 0 || str(cancel?.policyTypeKey) === "free_cancellation";
    const description = tagText(cancel?.description);
    const freeWindow = refundable ? freeCancelWindow(description) : undefined;
    const rooms = new Set<number>();
    const roomId = num(descriptor?.roomStay?.roomId);
    if (roomId !== undefined) rooms.add(roomId);

    groups.set(key, {
      ref: key,
      name: "", // filled in below, once every group is known
      mealPlan: mealPlanLabel(mealEnum),
      refundable,
      cancelDeadlineValue: freeWindow?.value,
      cancelDeadlineUnit: freeWindow?.unit,
      // Kept ONLY when a refundable rate has no readable window: with neither,
      // the rate reads as "free cancellation any time before arrival"
      // (describePolicy) — a promise the listing never made. With a window, our
      // own generated copy is better than Booking's paragraph.
      cancellationNote: refundable && !freeWindow ? description : undefined,
      prepayment: tagText(prepay?.title),
      roomCount: 0,
      rooms,
    });
  }

  const rates = [...groups.values()].map((g) => ({
    ...g,
    name: `${g.mealPlan ?? "Room only"} — ${g.refundable ? "free cancellation" : "non-refundable"}`,
    roomCount: g.rooms.size,
  }));
  // Two Booking rate ids can describe themselves identically — a hotel selling
  // the same meal plan and cancellation type twice, usually with a longer free
  // window on one. Both are real plans, so keep both and make the names tell
  // them apart by the difference that actually distinguishes them. Counted
  // BEFORE any renaming, so both halves of a clash get the same treatment.
  const clashes = (list: BookingImportRate[]) => {
    const seen = new Map<string, number>();
    for (const r of list) seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
    return seen;
  };
  const byBaseName = clashes(rates);
  for (const rate of rates) {
    if ((byBaseName.get(rate.name) ?? 0) < 2 || rate.cancelDeadlineValue === undefined) continue;
    const n = rate.cancelDeadlineValue;
    const unit = (rate.cancelDeadlineUnit === "days" ? "day" : "hour") + (n === 1 ? "" : "s");
    rate.name += ` (${n} ${unit} before arrival)`;
  }
  // Still tied — no window to separate them: number them rather than hand the
  // owner two rows with one name.
  const byName = clashes(rates);
  for (const [i, rate] of rates.entries()) {
    if ((byName.get(rate.name) ?? 0) > 1) rate.name += ` (${i + 1})`;
  }
  return rates.map(({ rooms: _rooms, ...rate }) => rate);
}

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
    rates: parseRatePlans(cache),
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
  /** Rate-plan refs to import. */
  rateRefs: Set<string>;
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

  // Rate plans carry no price. Booking's figures are OTA sell prices for the one
  // date we fetched — taxes folded in, Genius and campaign discounts applied,
  // per party size — not a base nightly rate, so writing them would put a wrong
  // number in front of guests. A rate with no price in `prices` is offered on no
  // room, which is exactly right until the owner sets one; the setup checklist
  // ("no rooms priced") is what tells them.
  const rates = payload.rates.filter((r) => sel.rateRefs.has(r.ref));
  if (rates.length) {
    await replaceRates(
      pid,
      rates.map((r): CatalogRate => {
        // The payload round-trips through the form, so these values are
        // caller-controlled — clamp the two the policy engine reads.
        const deadline = Math.round(Number(r.cancelDeadlineValue));
        return {
          id: crypto.randomUUID(),
          title: r.name,
          mealPlan: r.mealPlan,
          prices: {},
          refundable: r.refundable !== false,
          cancelDeadlineValue: Number.isFinite(deadline) && deadline >= 0 ? deadline : undefined,
          cancelDeadlineUnit: r.cancelDeadlineUnit === "days" ? "days" : "hours",
          cancellationNote: r.cancellationNote,
          inclusions: [],
          active: true,
          createdAt: now,
        };
      }),
    );
  }
  return pid;
}
