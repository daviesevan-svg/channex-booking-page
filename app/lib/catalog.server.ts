// Manually-created rooms and rate plans (the booking engine's own catalog),
// replacing the live Channex shopping source. Stored in KV per property. Prices
// here are the base nightly price; per-date ARI pushed via the Open Channel API
// (D1) will later override these.
import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns";

import { getInventory } from "./ari.server";
import type { ClosedDates, RatePlan, RoomsQuery, RoomWithRates } from "./channex/types";
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

// ---- public read: build RoomWithRates from the catalog ----
/** The catalog as `RoomWithRates[]` for a given stay, so the guest-facing
 *  loaders, cart and occupancy logic work unchanged. Total = nightly × nights;
 *  availability is assumed open until per-date ARI arrives via Open Channel. */
export async function getCatalogRooms(pid: string, query: RoomsQuery = {}): Promise<RoomWithRates[]> {
  const [rooms, rates] = await Promise.all([getRooms(pid), getRates(pid)]);
  const nights =
    query.checkinDate && query.checkoutDate
      ? Math.max(1, differenceInCalendarDays(parseISO(query.checkoutDate), parseISO(query.checkinDate)))
      : 1;
  const currency = query.currency || "GBP";

  return rooms
    .map((room): RoomWithRates => {
      // Occupancy drives the search "fits" check and cart coverage, so it
      // reflects the room's capacity (not the rate's priced occupancy).
      const occupancy = {
        adults: room.maxAdults,
        children: Math.max(0, room.maxGuests - room.maxAdults),
        infants: 0,
      };
      const ratePlans: RatePlan[] = rates
        .filter((r) => r.roomId === room.id && r.active)
        .map((r) => {
          const total = (r.nightlyPrice * nights).toFixed(2);
          return {
            id: r.id,
            title: r.title,
            occupancy,
            mealPlan: r.mealPlan ?? null,
            currency,
            totalPrice: total,
            netPrice: total, // no separate tax for manual rates
            availability: 99,
            inclusions: r.inclusions.length ? r.inclusions : undefined,
            cancellationNote: r.cancellationNote || (r.refundable ? undefined : "Non-refundable"),
          };
        });
      return {
        id: room.id,
        title: room.title,
        description: room.description,
        facilities: room.facilities,
        photos: room.images.map((url) => ({ url })),
        ratePlans,
      };
    })
    .filter((room) => room.ratePlans.length > 0);
}

/** Calendar availability for [from, to] (inclusive), in the Channex ClosedDates
 *  shape the date picker consumes. A date is closed when no room is bookable
 *  (availability 0, or every active rate stop-sold). minStayArrival is the
 *  smallest min-stay among the bookable rates that day. Dates with no inventory
 *  row are treated as open (default-available, same as the booking flow). */
export async function getCalendarAvailability(
  pid: string,
  from: string,
  to: string,
): Promise<ClosedDates> {
  const [rooms, rates, inv] = await Promise.all([getRooms(pid), getRates(pid), getInventory(pid, from, to)]);
  const ratesByRoom = new Map<string, CatalogRate[]>();
  for (const r of rates) {
    if (!r.active) continue;
    (ratesByRoom.get(r.roomId) ?? ratesByRoom.set(r.roomId, []).get(r.roomId)!).push(r);
  }

  const closed: string[] = [];
  const minStayArrival: Record<string, number> = {};
  const end = parseISO(to);
  for (let d = parseISO(from); d <= end; d = addDays(d, 1)) {
    const date = format(d, "yyyy-MM-dd");
    let bookable = false;
    let minStay = Infinity;
    for (const room of rooms) {
      const roomRates = ratesByRoom.get(room.id);
      if (!roomRates?.length) continue;
      const avail = inv.availability[`${room.id}|${date}`];
      if (avail !== undefined && avail <= 0) continue; // sold out (undefined = open)
      const openRates = roomRates.filter((rt) => !inv.restrictions[`${rt.id}|${date}`]?.stopSell);
      if (!openRates.length) continue;
      bookable = true;
      for (const rt of openRates) minStay = Math.min(minStay, inv.restrictions[`${rt.id}|${date}`]?.minStay || 1);
    }
    if (!bookable) closed.push(date);
    else if (Number.isFinite(minStay) && minStay > 1) minStayArrival[date] = minStay;
  }

  return { closed, closedToArrival: [], closedToDeparture: [], minStayArrival, minStayThrough: {} };
}
