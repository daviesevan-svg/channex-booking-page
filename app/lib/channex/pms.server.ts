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
  /** Best-effort base nightly price from the primary occupancy option (may need
   *  review after import; live nightly rates flow via Open Channel ARI). */
  nightlyPrice?: number;
  defaultOccupancy?: number;
}

type JsonApiRecord = { id: string; type: string; attributes: Record<string, unknown> };

/** GET a Channex PMS endpoint with the owner's api key. Returns the parsed
 *  `data` (camelCased). Throws a friendly Error on non-2xx / network failure. */
async function pmsGet(path: string, apiKey: string): Promise<JsonApiRecord[]> {
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
  const json = (await res.json().catch(() => ({}))) as { data?: unknown };
  const data = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
  return convertToCamelCase(data) as JsonApiRecord[];
}

const str = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s || undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Every property the api key can see. */
export async function listChannexProperties(apiKey: string): Promise<ChannexProperty[]> {
  const rows = await pmsGet("/properties", apiKey);
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
  const rows = await pmsGet(`/room_types?filter[property_id]=${encodeURIComponent(propertyId)}`, apiKey);
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

/** Rate plans for one property. */
export async function getChannexRatePlans(
  apiKey: string,
  propertyId: string,
): Promise<ChannexRatePlan[]> {
  const rows = await pmsGet(`/rate_plans?filter[property_id]=${encodeURIComponent(propertyId)}`, apiKey);
  return rows.map((r) => {
    const a = r.attributes ?? {};
    const options = Array.isArray(a.options) ? (a.options as Record<string, unknown>[]) : [];
    const primary = options.find((o) => o.isPrimary) ?? options[0];
    const mealRaw = str(a.mealType) ?? str(a.mealPlan);
    return {
      id: r.id,
      title: str(a.title) ?? "Rate",
      roomTypeId: str(a.roomTypeId) ?? "",
      mealPlan: mealRaw ? (MEAL_LABELS[mealRaw] ?? mealRaw) : undefined,
      currency: str(a.currency),
      nightlyPrice: primary ? num(primary.rate) : undefined,
      defaultOccupancy: primary ? num(primary.occupancy) : undefined,
    };
  });
}
