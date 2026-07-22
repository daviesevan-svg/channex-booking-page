// Read-only client for the Channex PMS REST API, used by the "Onboard from
// Channex" flow to pull a property's details, room types and rate plans so the
// owner can create them locally. Authenticated with the owner's own personal
// `user-api-key` (pasted at onboard time, never stored). Distinct from the Open
// Channel client (client.ts), which uses the meta-channel path + channel keys.
import { getConfig } from "../config.server";
import { convertToCamelCase } from "./case";

export interface ChannexProperty {
  id: string;
  title: string;
  currency?: string;
  email?: string;
  phone?: string;
  timezone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
  latitude?: string;
  longitude?: string;
  description?: string;
}

export interface ChannexRoomType {
  id: string;
  title: string;
  description?: string;
  maxAdults: number;
  maxGuests: number;
  facilities: string[];
  photos: string[];
}

export interface ChannexRatePlan {
  id: string;
  title: string;
  roomTypeId: string;
  mealPlan?: string;
  currency?: string;
  occupancy?: number;
  /** True when this rate plan is distributed to a real OTA channel (Booking.com,
   *  Expedia, Airbnb…). We default these OFF at import — a commission-free direct
   *  engine usually sells the property's own direct rates, not its OTA rates. */
  ota: boolean;
  /** Titles of the OTA channels this rate plan is mapped to (for display). */
  otaChannels: string[];
}

type JsonApiRecord = { id: string; type: string; attributes: Record<string, unknown> };
interface PmsPage {
  data: JsonApiRecord[];
  meta?: Record<string, unknown>;
}

/** GET a Channex PMS endpoint with the owner's api key. Returns the parsed
 *  `data` (camelCased) plus the raw `meta` (for pagination). Throws a friendly
 *  Error on non-2xx / network failure. */
async function pmsFetch(path: string, apiKey: string): Promise<PmsPage> {
  const base = getConfig().apiUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      headers: { "user-api-key": apiKey, Accept: "application/json" },
    });
  } catch {
    throw new Error("Couldn't reach Channex. Check your connection and try again.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Channex rejected that API key. Double-check it and try again.");
  }
  if (!res.ok) throw new Error(`Channex returned an error (${res.status}). Try again shortly.`);
  const json = (await res.json().catch(() => ({}))) as { data?: unknown; meta?: Record<string, unknown> };
  const raw = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
  return { data: convertToCamelCase(raw) as JsonApiRecord[], meta: json.meta };
}

/** Single request — for endpoints that return the whole collection at once
 *  (the `/options` endpoints, and `/channels`). */
async function pmsGet(path: string, apiKey: string): Promise<JsonApiRecord[]> {
  return (await pmsFetch(path, apiKey)).data;
}

/** Follows Channex JSON:API pagination (`meta.total`/`meta.limit`) so we get the
 *  ENTIRE collection, not just the default first page of 10. Used for the full
 *  record endpoints (`/properties`, `/room_types`). Capped at 20 pages (2000
 *  records) as a runaway guard. */
async function pmsGetAll(path: string, apiKey: string): Promise<JsonApiRecord[]> {
  const sep = path.includes("?") ? "&" : "?";
  const all: JsonApiRecord[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, meta } = await pmsFetch(`${path}${sep}pagination[page]=${page}&pagination[limit]=100`, apiKey);
    all.push(...data);
    const total = typeof meta?.total === "number" ? meta.total : all.length;
    if (data.length === 0 || all.length >= total) break;
  }
  return all;
}

const str = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s || undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export interface ChannexBookingRoom {
  checkinDate?: string;
  checkoutDate?: string;
  /** Per-night prices keyed by stay date ("2026-07-21" → "120.00"). The keys are
   *  the authoritative stay dates. */
  days: Record<string, string | number>;
  amount?: string;
  occupancy?: { adults?: number; children?: number; infants?: number };
  roomTypeId?: string | null;
  ratePlanId?: string | null;
}

export interface ChannexBooking {
  id: string;
  propertyId: string;
  /** "new" | "modified" | "cancelled" */
  status: string;
  otaName?: string;
  arrivalDate: string;
  departureDate: string;
  insertedAt?: string;
  amount?: string;
  currency?: string;
  occupancy?: { adults?: number; children?: number; infants?: number };
  rooms: ChannexBookingRoom[];
}

function parseBooking(r: JsonApiRecord): ChannexBooking | null {
  const a = r.attributes ?? {};
  const propertyId = str(a.propertyId);
  const arrival = str(a.arrivalDate);
  const departure = str(a.departureDate);
  if (!propertyId || !arrival || !departure) return null;
  const rooms = (Array.isArray(a.rooms) ? (a.rooms as Record<string, unknown>[]) : []).map((room) => ({
    checkinDate: str(room.checkinDate),
    checkoutDate: str(room.checkoutDate),
    days: (room.days && typeof room.days === "object" ? room.days : {}) as Record<string, string | number>,
    amount: str(room.amount),
    occupancy: (room.occupancy ?? undefined) as ChannexBookingRoom["occupancy"],
    roomTypeId: str(room.roomTypeId) ?? null,
    ratePlanId: str(room.ratePlanId) ?? null,
  }));
  return {
    id: r.id,
    propertyId,
    status: str(a.status) ?? "new",
    otaName: str(a.otaName),
    arrivalDate: arrival,
    departureDate: departure,
    insertedAt: str(a.insertedAt),
    amount: str(a.amount),
    currency: str(a.currency),
    occupancy: (a.occupancy ?? undefined) as ChannexBooking["occupancy"],
    rooms,
  };
}

/** One page of the account's bookings (latest revision each), scoped to a
 *  property. `filter[property_id]` is sent, but because its support on the list
 *  endpoint isn't documented we also filter client-side — other properties'
 *  bookings are dropped, never imported. `insertedAtGte` (ISO timestamp) makes
 *  the fetch incremental: only bookings whose latest revision arrived at Channex
 *  after that moment (covers modifications and cancellations too). */
export async function getChannexBookingsPage(
  apiKey: string,
  propertyId: string,
  page: number,
  insertedAtGte?: string,
): Promise<{ bookings: ChannexBooking[]; pageSize: number; total: number }> {
  const params = new URLSearchParams();
  params.set("filter[property_id]", propertyId);
  if (insertedAtGte) params.set("filter[inserted_at][gte]", insertedAtGte);
  params.set("pagination[page]", String(page));
  params.set("pagination[limit]", "100");
  const { data, meta } = await pmsFetch(`/bookings?${params}`, apiKey);
  const total = typeof meta?.total === "number" ? meta.total : data.length;
  return {
    bookings: data.map(parseBooking).filter((b): b is ChannexBooking => b !== null && b.propertyId === propertyId),
    pageSize: data.length,
    total,
  };
}

/** Total physical rooms of a property (sum of each room type's count), used as
 *  the occupancy denominator in revenue analytics. */
export async function getChannexRoomCount(apiKey: string, propertyId: string): Promise<number> {
  const rows = await pmsGetAll(`/room_types?filter[property_id]=${encodeURIComponent(propertyId)}`, apiKey);
  return rows.reduce((sum, r) => sum + (num((r.attributes ?? {}).countOfRooms) ?? 0), 0);
}

/** Every property the api key can see. */
export async function listChannexProperties(apiKey: string): Promise<ChannexProperty[]> {
  const rows = await pmsGetAll("/properties", apiKey);
  return rows.map((r) => {
    const a = r.attributes ?? {};
    const loc = (a.location ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      title: str(a.title) ?? "Untitled property",
      currency: str(a.currency),
      email: str(a.email),
      phone: str(a.phone),
      timezone: str(a.timezone),
      address: str(a.address),
      city: str(a.city),
      state: str(a.state),
      country: str(a.country),
      zipCode: str(a.zipCode),
      latitude: str(a.latitude) ?? str(loc.lat) ?? str(loc.latitude),
      longitude: str(a.longitude) ?? str(loc.lng) ?? str(loc.longitude),
      description: str(a.description),
    };
  });
}

/** Room types for one property. */
export async function getChannexRoomTypes(
  apiKey: string,
  propertyId: string,
): Promise<ChannexRoomType[]> {
  // Full record endpoint (paginated) — the `/options` variant omits the room
  // description and photo gallery we want to import.
  const rows = await pmsGetAll(`/room_types?filter[property_id]=${encodeURIComponent(propertyId)}`, apiKey);
  return rows.map((r) => {
    const a = r.attributes ?? {};
    const content = (a.content ?? {}) as Record<string, unknown>;
    const occAdults = num(a.occAdults) ?? num(a.defaultOccupancy) ?? 2;
    const occChildren = num(a.occChildren) ?? 0;
    const facilities = Array.isArray(a.facilities)
      ? (a.facilities as unknown[]).filter((f): f is string => typeof f === "string")
      : [];
    const photoSrc = Array.isArray(a.photos)
      ? (a.photos as unknown[])
      : Array.isArray(content.photos)
        ? (content.photos as unknown[])
        : [];
    const photos = photoSrc
      .map((p) => (p && typeof p === "object" ? str((p as Record<string, unknown>).url) : str(p)))
      .filter((u): u is string => Boolean(u));
    return {
      id: r.id,
      title: str(a.title) ?? "Room",
      description: str(a.description) ?? str(content.description),
      maxAdults: Math.max(1, occAdults),
      maxGuests: Math.max(1, occAdults + occChildren),
      facilities,
      photos,
    };
  });
}

const MEAL_LABELS: Record<string, string> = {
  none: "Room only",
  all_inclusive: "All inclusive",
  breakfast: "Breakfast included",
  lunch: "Lunch included",
  dinner: "Dinner included",
  american: "American breakfast",
  bed_and_breakfast: "Bed & breakfast",
  half_board: "Half board",
  full_board: "Full board",
  continental_breakfast: "Continental breakfast",
};

// Channel types that are direct/metasearch feeds, NOT commission OTAs — a rate
// plan being mapped to one of these doesn't make it an "OTA rate plan". (Google
// Hotel ARI in particular is fed every rate plan, so counting it would flag
// everything.) Everything else — Booking.com, Expedia, Airbnb, Hopper, Agoda… —
// is treated as an OTA.
const NON_OTA_CHANNELS = new Set([
  "GoogleHotelARI",
  "GoogleHotelFreeBookingLinks",
  "GoogleHotelPriceFeed",
]);

/** Map of rate-plan id → titles of the OTA channels it's distributed to. Read
 *  from `/channels` (the OTA link lives in the channel's rate-plan mapping, not
 *  on the rate plan itself). Best-effort: if channels can't be read we just
 *  treat nothing as OTA rather than failing the import. */
async function getOtaRatePlanChannels(apiKey: string): Promise<Map<string, string[]>> {
  let channels: JsonApiRecord[];
  try {
    channels = await pmsGet("/channels", apiKey);
  } catch {
    return new Map();
  }
  const map = new Map<string, string[]>();
  for (const c of channels) {
    const a = c.attributes ?? {};
    const type = str(a.channel) ?? "";
    if (NON_OTA_CHANNELS.has(type)) continue;
    const title = str(a.title) ?? (type || "OTA");
    const mappings = Array.isArray(a.ratePlans) ? (a.ratePlans as Record<string, unknown>[]) : [];
    for (const m of mappings) {
      const rid = str(m.ratePlanId);
      if (!rid) continue;
      const arr = map.get(rid) ?? [];
      if (!arr.includes(title)) arr.push(title);
      map.set(rid, arr);
    }
  }
  return map;
}

/** Rate plans for one property. Uses the `/options` endpoint, which returns the
 *  whole set in a single request (the paginated `/rate_plans` list defaults to
 *  10). Each plan is flagged with whether it's distributed to an OTA channel. */
export async function getChannexRatePlans(
  apiKey: string,
  propertyId: string,
): Promise<ChannexRatePlan[]> {
  const [rows, otaMap] = await Promise.all([
    pmsGet(`/rate_plans/options?filter[property_id]=${encodeURIComponent(propertyId)}`, apiKey),
    getOtaRatePlanChannels(apiKey),
  ]);
  return rows.map((r) => {
    const a = r.attributes ?? {};
    const mealRaw = str(a.mealType) ?? str(a.mealPlan);
    const otaChannels = otaMap.get(r.id) ?? [];
    return {
      id: r.id,
      title: str(a.title) ?? "Rate",
      roomTypeId: str(a.roomTypeId) ?? "",
      mealPlan: mealRaw ? (MEAL_LABELS[mealRaw] ?? mealRaw) : undefined,
      currency: str(a.currency),
      occupancy: num(a.occupancy),
      ota: otaChannels.length > 0,
      otaChannels,
    };
  });
}
