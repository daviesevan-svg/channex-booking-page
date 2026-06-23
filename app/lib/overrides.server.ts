import type { RoomWithRates } from "./channex/types";
import { getConfigKV } from "./config.server";

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

export async function saveRoomOverride(
  propertyId: string,
  roomId: string,
  input: Record<string, FormDataEntryValue>,
): Promise<RoomOverride> {
  const next: RoomOverride = {};
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const images = String(input.images ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (name) next.name = name;
  if (description) next.description = description;
  if (images.length) next.images = images;

  const all = await getRoomOverrides(propertyId);
  if (Object.keys(next).length) all[roomId] = next;
  else delete all[roomId];

  const kv = getConfigKV();
  if (kv) await kv.put(roomsKey(propertyId), JSON.stringify(all));
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
