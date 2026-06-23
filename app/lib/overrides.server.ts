import type { RoomWithRates } from "./channex/types";
import { getConfigKV } from "./config.server";
import { isThemeId, normalizeHex, type SearchContent, type SiteSettings } from "./content";

// Per-property content overrides edited in the admin. Anything unset falls back
// to the Channex property_info. Extend this as the admin grows (colors, images…).
export interface PropertyOverrides {
  hotelName?: string;
  address?: string;
  description?: string;
  phone?: string;
  email?: string;
}

const OVERRIDE_FIELDS: (keyof PropertyOverrides)[] = [
  "hotelName",
  "address",
  "description",
  "phone",
  "email",
];

const key = (propertyId: string) => `overrides:${propertyId}`;

export async function getOverrides(propertyId: string): Promise<PropertyOverrides> {
  const kv = getConfigKV();
  if (!kv) return {};
  const raw = await kv.get(key(propertyId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PropertyOverrides;
  } catch {
    return {};
  }
}

/** Persist overrides; empty strings clear a field (fall back to Channex). */
export async function saveOverrides(
  propertyId: string,
  input: Record<string, FormDataEntryValue>,
): Promise<PropertyOverrides> {
  const next: PropertyOverrides = {};
  for (const field of OVERRIDE_FIELDS) {
    const value = String(input[field] ?? "").trim();
    if (value) next[field] = value;
  }
  const kv = getConfigKV();
  if (kv) await kv.put(key(propertyId), JSON.stringify(next));
  return next;
}

// ---------- per-room content overrides ----------
export interface RoomOverride {
  name?: string;
  description?: string;
  images?: string[];
}

type RoomOverridesMap = Record<string, RoomOverride>;

const roomsKey = (propertyId: string) => `rooms:${propertyId}`;

export async function getRoomOverrides(propertyId: string): Promise<RoomOverridesMap> {
  const kv = getConfigKV();
  if (!kv) return {};
  const raw = await kv.get(roomsKey(propertyId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RoomOverridesMap;
  } catch {
    return {};
  }
}

export async function getRoomOverride(
  propertyId: string,
  roomId: string,
): Promise<RoomOverride> {
  return (await getRoomOverrides(propertyId))[roomId] ?? {};
}

export async function putRoomOverride(
  propertyId: string,
  roomId: string,
  ov: RoomOverride,
): Promise<RoomOverride> {
  const next: RoomOverride = {};
  if (ov.name?.trim()) next.name = ov.name.trim();
  if (ov.description?.trim()) next.description = ov.description.trim();
  const images = (ov.images ?? []).map((s) => s.trim()).filter(Boolean);
  if (images.length) next.images = images;

  const all = await getRoomOverrides(propertyId);
  if (Object.keys(next).length) all[roomId] = next;
  else delete all[roomId];

  const kv = getConfigKV();
  if (kv) await kv.put(roomsKey(propertyId), JSON.stringify(all));
  return next;
}

// ---------- editable page content ----------
interface SiteContent {
  search?: SearchContent;
}

const contentKey = (propertyId: string) => `content:${propertyId}`;

async function getSiteContent(propertyId: string): Promise<SiteContent> {
  const kv = getConfigKV();
  if (!kv) return {};
  const raw = await kv.get(contentKey(propertyId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SiteContent;
  } catch {
    return {};
  }
}

export async function getSearchContent(propertyId: string): Promise<SearchContent> {
  return (await getSiteContent(propertyId)).search ?? {};
}

export async function saveSearchContent(
  propertyId: string,
  search: SearchContent,
): Promise<void> {
  const kv = getConfigKV();
  if (!kv) return;
  const content = await getSiteContent(propertyId);
  content.search = search;
  await kv.put(contentKey(propertyId), JSON.stringify(content));
}

// ---------- general site settings (theme, custom domain) ----------
const settingsKey = (propertyId: string) => `settings:${propertyId}`;

export async function getSettings(propertyId: string): Promise<SiteSettings> {
  const kv = getConfigKV();
  if (!kv) return {};
  const raw = await kv.get(settingsKey(propertyId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SiteSettings;
  } catch {
    return {};
  }
}

export async function saveSettings(
  propertyId: string,
  input: Record<string, FormDataEntryValue>,
): Promise<SiteSettings> {
  const themeRaw = String(input.theme ?? "").trim();
  const next: SiteSettings = {
    theme: themeRaw === "custom" || isThemeId(themeRaw) ? (themeRaw as SiteSettings["theme"]) : undefined,
    customColor: normalizeHex(String(input.customColor ?? "")),
    customBg: normalizeHex(String(input.customBg ?? "")),
    customDomain:
      String(input.customDomain ?? "")
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "") || undefined,
  };
  const kv = getConfigKV();
  if (kv) await kv.put(settingsKey(propertyId), JSON.stringify(next));
  return next;
}

/** Apply a room's content override on top of the Channex room (keeps rate plans). */
export function mergeRoomOverride(room: RoomWithRates, ov?: RoomOverride): RoomWithRates {
  if (!ov) return room;
  return {
    ...room,
    title: ov.name || room.title,
    description: ov.description || room.description,
    photos: ov.images?.length ? ov.images.map((url) => ({ url })) : room.photos,
  };
}
