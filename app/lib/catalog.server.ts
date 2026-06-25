// Manually-created rooms and rate plans (the booking engine's own catalog),
// replacing the live Channex shopping source. Stored in KV per property. Prices
// here are the base nightly price; per-date ARI pushed via the Open Channel API
// (D1) will later override these.
import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns";

import { getInventory, type MappingRoomType } from "./ari.server";
import type { ClosedDates, RatePlan, RoomsQuery, RoomWithRates } from "./channex/types";
import { getConfigKV } from "./config.server";
import type { DeadlineUnit } from "./content";
import { getSettings } from "./overrides.server";

export interface CatalogRoom {
  id: string;
  title: string;
  description?: string;
  images: string[];
  /** Max adults this room sleeps. */
  maxAdults: number;
  /** Total heads (adults + children) this room sleeps. */
  maxGuests: number;
  /** Flat cleaning fee, charged once per room per stay (VAT always applies). */
  cleaningFee?: number;
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

/** The catalog as Open Channel mapping_details: our room types + active rate
 *  plans, with our ids, so Channex can map the hotel's rooms onto them and then
 *  push ARI keyed by these same ids. */
export async function getCatalogMapping(pid: string): Promise<MappingRoomType[]> {
  const [rooms, rates, settings] = await Promise.all([getRooms(pid), getRates(pid), getSettings(pid)]);
  const currency = settings.currency || "GBP";
  return rooms
    .map((room) => ({
      id: room.id,
      title: room.title,
      rate_plans: rates
        .filter((r) => r.roomId === room.id && r.active)
        .map((r) => ({
          id: r.id,
          title: r.title,
          sell_mode: "per_room",
          max_persons: room.maxGuests,
          currency,
          read_only: false,
        })),
    }))
    .filter((rt) => rt.rate_plans.length > 0);
}

// ---- public read: build RoomWithRates from the catalog ----
/** The catalog as `RoomWithRates[]` for a given stay. Each night is priced from
 *  the D1 ARI (falling back to the rate's base nightly price), and availability
 *  reflects the room's lowest nightly count over the stay.
 *
 *  With `gate: true` (results/detail/checkout) sold-out rooms, stop-sold rates
 *  and stays under a rate's min-stay are dropped, so only bookable options
 *  appear. Confirmation omits the gate — it's showing a completed booking. */
export async function getCatalogRooms(
  pid: string,
  query: RoomsQuery = {},
  opts: { gate?: boolean } = {},
): Promise<RoomWithRates[]> {
  const gate = opts.gate ?? false;
  const [rooms, rates] = await Promise.all([getRooms(pid), getRates(pid)]);
  const { checkinDate, checkoutDate, currency: cur } = query;
  const nights =
    checkinDate && checkoutDate
      ? Math.max(1, differenceInCalendarDays(parseISO(checkoutDate), parseISO(checkinDate)))
      : 1;
  const currency = cur || "GBP";
  // The nights occupied by the stay: checkin .. checkout-1.
  const nightDates = checkinDate
    ? Array.from({ length: nights }, (_, i) => format(addDays(parseISO(checkinDate), i), "yyyy-MM-dd"))
    : [];
  // Query through the checkout date too, so the CTD check below sees it.
  const inv = nightDates.length
    ? await getInventory(pid, nightDates[0], checkoutDate ?? nightDates[nightDates.length - 1])
    : { availability: {}, prices: {}, restrictions: {} };

  return rooms
    .map((room): RoomWithRates => {
      const occupancy = {
        adults: room.maxAdults,
        children: Math.max(0, room.maxGuests - room.maxAdults),
        infants: 0,
      };
      // Room availability = the lowest nightly count over the stay (unset = open).
      let roomAvail = Infinity;
      for (const d of nightDates) {
        const a = inv.availability[`${room.id}|${d}`];
        if (a !== undefined) roomAvail = Math.min(roomAvail, a);
      }
      const soldOut = gate && nightDates.length > 0 && roomAvail <= 0;
      const availForRate = Number.isFinite(roomAvail) ? roomAvail : 99;

      const ratePlans = soldOut
        ? []
        : rates
            .filter((r) => r.roomId === room.id && r.active)
            .map((r): RatePlan | null => {
              if (gate) {
                if (nightDates.some((d) => inv.restrictions[`${r.id}|${d}`]?.stopSell)) return null;
                const minStay = (checkinDate && inv.restrictions[`${r.id}|${checkinDate}`]?.minStay) || 1;
                if (nights < minStay) return null;
                if (checkinDate && inv.restrictions[`${r.id}|${checkinDate}`]?.cta) return null; // closed to arrival
                if (checkoutDate && inv.restrictions[`${r.id}|${checkoutDate}`]?.ctd) return null; // closed to departure
              }
              const raw = nightDates.length
                ? nightDates.reduce((s, d) => s + (inv.prices[`${r.id}|${d}`] ?? r.nightlyPrice), 0)
                : r.nightlyPrice * nights;
              const total = (Math.round(raw * 100) / 100).toFixed(2);
              return {
                id: r.id,
                title: r.title,
                occupancy,
                mealPlan: r.mealPlan ?? null,
                currency,
                totalPrice: total,
                netPrice: total, // no separate tax for manual rates
                availability: availForRate,
                inclusions: r.inclusions.length ? r.inclusions : undefined,
                cancellationNote: r.cancellationNote || (r.refundable ? undefined : "Non-refundable"),
              };
            })
            .filter((rp): rp is RatePlan => rp !== null);

      return {
        id: room.id,
        title: room.title,
        description: room.description,
        facilities: room.facilities,
        photos: room.images.map((url) => ({ url })),
        cleaningFee: room.cleaningFee,
        ratePlans,
      };
    })
    .filter((room) => room.ratePlans.length > 0);
}

/** Calendar availability for [from, to] (inclusive), in the Channex ClosedDates
 *  shape the date picker consumes. A date is closed when no room is bookable
 *  (availability 0, or every active rate stop-sold); closedToArrival/Departure
 *  when every otherwise-bookable rate is closed to arrival/departure that day;
 *  minStayArrival is the smallest min-stay among the bookable rates. Dates with
 *  no inventory row are open (default-available, same as the booking flow). */
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
  const closedToArrival: string[] = [];
  const closedToDeparture: string[] = [];
  const minStayArrival: Record<string, number> = {};
  const end = parseISO(to);
  for (let d = parseISO(from); d <= end; d = addDays(d, 1)) {
    const date = format(d, "yyyy-MM-dd");
    let bookable = false;
    let minStay = Infinity;
    let arrivalOpen = false;
    let departureOpen = false;
    for (const room of rooms) {
      const roomRates = ratesByRoom.get(room.id);
      if (!roomRates?.length) continue;
      const avail = inv.availability[`${room.id}|${date}`];
      if (avail !== undefined && avail <= 0) continue; // sold out (undefined = open)
      for (const rt of roomRates) {
        const r = inv.restrictions[`${rt.id}|${date}`];
        if (r?.stopSell) continue; // rate not bookable this day
        bookable = true;
        minStay = Math.min(minStay, r?.minStay || 1);
        if (!r?.cta) arrivalOpen = true;
        if (!r?.ctd) departureOpen = true;
      }
    }
    if (!bookable) {
      closed.push(date);
      continue;
    }
    if (Number.isFinite(minStay) && minStay > 1) minStayArrival[date] = minStay;
    if (!arrivalOpen) closedToArrival.push(date);
    if (!departureOpen) closedToDeparture.push(date);
  }

  return { closed, closedToArrival, closedToDeparture, minStayArrival, minStayThrough: {} };
}
