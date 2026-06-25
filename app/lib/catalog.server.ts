// Manually-created rooms and rate plans (the booking engine's own catalog),
// replacing the live Channex shopping source. Stored in KV per property. Prices
// here are the base nightly price; per-date ARI pushed via the Open Channel API
// (D1) will later override these.
import { getConfigKV } from "./config.server";
import type { DeadlineUnit } from "./content";

export interface CatalogRoom {
  id: string;
  title: string;
  description?: string;
  images: string[];
  /** Max adults this room sleeps. */
  maxAdults: number;
  /** Total heads (adults + children) this room sleeps. */
  maxGuests: number;
  facilities: string[];
  position: number;
  createdAt: string;
}

export interface CatalogRate {
  id: string;
  roomId: string;
  title: string;
  mealPlan?: string;
  /** Base price per night in the property currency. */
  nightlyPrice: number;
  /** Occupancy this rate is priced for. */
  adults: number;
  children: number;
  // Cancellation policy (mirrors the structured rate-plan override fields).
  refundable: boolean;
  cancelDeadlineValue?: number;
  cancelDeadlineUnit?: DeadlineUnit;
  cancellationNote?: string;
  inclusions: string[];
  active: boolean;
  createdAt: string;
}

const roomsKey = (pid: string) => `catalog_rooms:${pid}`;
const ratesKey = (pid: string) => `catalog_rates:${pid}`;

async function readArr<T>(key: string): Promise<T[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as T[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function writeArr<T>(key: string, list: T[]): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(key, JSON.stringify(list));
}

// ---- rooms ----
export async function getRooms(pid: string): Promise<CatalogRoom[]> {
  return (await readArr<CatalogRoom>(roomsKey(pid))).sort((a, b) => a.position - b.position);
}
export async function getRoom(pid: string, id: string): Promise<CatalogRoom | undefined> {
  return (await getRooms(pid)).find((r) => r.id === id);
}
export async function saveRoom(pid: string, room: CatalogRoom): Promise<void> {
  const list = await readArr<CatalogRoom>(roomsKey(pid));
  const i = list.findIndex((r) => r.id === room.id);
  if (i === -1) list.push(room);
  else list[i] = room;
  await writeArr(roomsKey(pid), list);
}
export async function deleteRoom(pid: string, id: string): Promise<void> {
  const rooms = (await readArr<CatalogRoom>(roomsKey(pid))).filter((r) => r.id !== id);
  await writeArr(roomsKey(pid), rooms);
  // Cascade: drop rates that belonged to the room.
  const rates = (await readArr<CatalogRate>(ratesKey(pid))).filter((r) => r.roomId !== id);
  await writeArr(ratesKey(pid), rates);
}

// ---- rates ----
export async function getRates(pid: string): Promise<CatalogRate[]> {
  return readArr<CatalogRate>(ratesKey(pid));
}
export async function getRatesForRoom(pid: string, roomId: string): Promise<CatalogRate[]> {
  return (await getRates(pid)).filter((r) => r.roomId === roomId);
}
export async function getRate(pid: string, id: string): Promise<CatalogRate | undefined> {
  return (await getRates(pid)).find((r) => r.id === id);
}
export async function saveRate(pid: string, rate: CatalogRate): Promise<void> {
  const list = await getRates(pid);
  const i = list.findIndex((r) => r.id === rate.id);
  if (i === -1) list.push(rate);
  else list[i] = rate;
  await writeArr(ratesKey(pid), list);
}
export async function deleteRate(pid: string, id: string): Promise<void> {
  const list = (await getRates(pid)).filter((r) => r.id !== id);
  await writeArr(ratesKey(pid), list);
}
