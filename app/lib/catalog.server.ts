// Manually-created rooms and rate plans (the booking engine's own catalog),
// replacing the live Channex shopping source. Stored in KV per property. Prices
// here are the base nightly price; per-date ARI pushed via the Open Channel API
// (D1) will later override these.
import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns";

import { getInventory, type MappingRoomType } from "./ari.server";
import type { ClosedDates, RatePlan, RoomsQuery, RoomWithRates } from "./channex/types";
import { getConfigKV } from "./config.server";
import type { DeadlineUnit, PricingMode, SiteSettings } from "./content";
import { getSettings } from "./overrides.server";
import { getPromotions } from "./promotions.server";
import { childrenNightlyDelta, occupancyNightlyDelta, perPersonPrice, type OccupancyPricing } from "./rate-pricing";
import { ratePolicyOf, type RatePolicy } from "./rate-policy";
import { policyToCancellation } from "./policy-copy";
import { lineOccupancy, type CartLine, type ResolvedLine } from "./cart";
import { roomCapacity } from "./occupancy";

// Re-export so existing importers (admin rate editor) keep their import path.
export { occupancyNightlyDelta, type OccupancyPricing } from "./rate-pricing";
import { bestAutoOffer, valueAddViews } from "./promotions";

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
  /** Free-text facilities, one per line in the editor. Shown to guests as-is;
   *  NOT sent to Google (which only accepts its fixed amenity vocabulary). */
  facilities: string[];
  /** Structured amenities — Google amenity keys from VR_AMENITIES (content.ts).
   *  Shown to guests (translated) and sent to Google for VR listings. */
  amenities?: string[];
  position: number;
  createdAt: string;
}

export interface CatalogRate {
  id: string;
  title: string;
  mealPlan?: string;
  /** Base nightly price keyed by room id (in the property currency). A rate is
   *  offered on a room only when it has a price here, so one rate plan can apply
   *  to every room at its own price. Occupancy is taken from each room. */
  prices: Record<string, number>;
  /** LEGACY — the pricing mode is property-wide now (settings.pricingMode);
   *  Channex applies sell mode to the whole channel connection, so it can't
   *  vary per rate. Kept only so pre-setting data still derives the right mode
   *  (see pricingModeOf); the rate editor preserves it but the UI is gone. */
  perPerson?: boolean;
  /** Optional per-person pricing rules (absent = flat price for any party).
   *  This is the rate-wide default, applied to every room unless overridden. */
  occupancyPricing?: OccupancyPricing;
  /** Optional per-room overrides of `occupancyPricing`, keyed by room id — for
   *  hotels where an extra adult costs more in some rooms than others. A room
   *  not listed here falls back to the rate-wide `occupancyPricing`. */
  occupancyPricingByRoom?: Record<string, OccupancyPricing>;
  /** For rates imported from Channex, the real per-room Channex rate_plan_id
   *  (roomId → id). Channex stores one rate plan per room type, but we present
   *  a single consolidated rate; ARI, mapping and booking pushes still key by
   *  the room's own Channex id. Absent for native rates (they key by `id`). */
  channexRateIds?: Record<string, string>;
  /** Structured payment + cancellation + no-show policy. When absent, the legacy
   *  flat fields below are used (see ratePolicyOf in rate-policy.ts). */
  policy?: RatePolicy;
  // Legacy cancellation fields (kept in sync by the editor for back-compat).
  refundable: boolean;
  cancelDeadlineValue?: number;
  cancelDeadlineUnit?: DeadlineUnit;
  cancellationNote?: string;
  inclusions: string[];
  active: boolean;
  createdAt: string;
}

/** Legacy rates were single-room (`roomId` + one `nightlyPrice`, plus `adults`/
 *  `children` that the booking flow already ignored in favour of the room). Map
 *  them onto the per-room `prices` shape on read so old KV data keeps working. */
function normalizeRate(raw: CatalogRate & { roomId?: string; nightlyPrice?: number }): CatalogRate {
  if (raw.prices && typeof raw.prices === "object") return raw;
  const prices: Record<string, number> = {};
  if (raw.roomId && typeof raw.nightlyPrice === "number") prices[raw.roomId] = raw.nightlyPrice;
  const { roomId: _r, nightlyPrice: _n, ...rest } = raw as CatalogRate & {
    roomId?: string;
    nightlyPrice?: number;
    adults?: number;
    children?: number;
  };
  return { ...rest, prices };
}

/** The Channex rate_plan_id to use for a given room — the imported per-room id
 *  when present, otherwise the rate's own id. This is the id that ARI, mapping
 *  and booking pushes key by (see channexRateIds). */
export function rateChannexId(rate: Pick<CatalogRate, "id" | "channexRateIds">, roomId: string): string {
  return rate.channexRateIds?.[roomId] ?? rate.id;
}

/** Lowest price across the rooms a rate is offered on (undefined if none). */
export function rateFromPrice(rate: CatalogRate): number | undefined {
  const vals = Object.values(rate.prices);
  return vals.length ? Math.min(...vals) : undefined;
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
  // Cascade: drop this room's price from every rate (a rate priced for no rooms
  // simply isn't offered anywhere — the rate plan itself is kept).
  const rates = (await getRates(pid)).map((r) => {
    if (r.prices[id] === undefined) return r;
    const { [id]: _drop, ...prices } = r.prices;
    return { ...r, prices };
  });
  await writeArr(ratesKey(pid), rates);
}

// ---- rates ----
export async function getRates(pid: string): Promise<CatalogRate[]> {
  return (await readArr<CatalogRate>(ratesKey(pid))).map(normalizeRate);
}
export async function getRatesForRoom(pid: string, roomId: string): Promise<CatalogRate[]> {
  return (await getRates(pid)).filter((r) => r.prices[roomId] !== undefined);
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

// ---- pricing mode ----
/** The property's effective pricing mode. Explicit setting first; data saved
 *  before the setting existed falls back to the per-rate flags (any flagged
 *  rate = the property was priced per person — modes were never legally mixed,
 *  Channex applies one per channel). */
export function pricingModeOf(settings: SiteSettings, rates: CatalogRate[]): PricingMode {
  return settings.pricingMode ?? (rates.some((r) => r.perPerson) ? "per_person" : "per_room");
}
export async function getPricingMode(pid: string): Promise<PricingMode> {
  const [settings, rates] = await Promise.all([getSettings(pid), getRates(pid)]);
  return pricingModeOf(settings, rates);
}

/** Replace the whole rooms / rates list in one write. Used by the Channex
 *  import so a re-import rebuilds the catalog cleanly instead of piling new
 *  records on top of a previous import's. */
export async function replaceRooms(pid: string, rooms: CatalogRoom[]): Promise<void> {
  await writeArr(roomsKey(pid), rooms);
}
export async function replaceRates(pid: string, rates: CatalogRate[]): Promise<void> {
  await writeArr(ratesKey(pid), rates);
}

/** The catalog as Open Channel mapping_details: our room types + active rate
 *  plans, with our ids, so Channex can map the hotel's rooms onto them and then
 *  push ARI keyed by these same ids. */
export async function getCatalogMapping(pid: string): Promise<MappingRoomType[]> {
  const [rooms, rates, settings] = await Promise.all([getRooms(pid), getRates(pid), getSettings(pid)]);
  const currency = settings.currency || "GBP";
  // One sell mode for the whole property: Channex applies it per channel
  // connection, so advertising a per-rate mix would be a mapping it can't fulfil.
  const perPerson = pricingModeOf(settings, rates) === "per_person";
  return rooms
    .map((room) => ({
      id: room.id,
      title: room.title,
      rate_plans: rates
        .filter((r) => r.active && r.prices[room.id] !== undefined)
        .map((r) => ({
          // Advertise the room's real Channex rate id so Channel mapping and the
          // ARI it pushes back line up per room, even though we present one rate.
          id: rateChannexId(r, room.id),
          title: r.title,
          // Advertising per_person makes Channex map its per-person plans here
          // and push a price for every occupancy 1..max_persons (adults).
          sell_mode: perPerson ? "per_person" : "per_room",
          max_persons: perPerson ? Math.max(1, room.maxAdults) : room.maxGuests,
          currency,
          read_only: false,
        })),
    }))
    .filter((rt) => rt.rate_plans.length > 0);
}

/** Why a room or rate was withheld for a stay. Emitted only when a caller asks
 *  for it (see `getCatalogRooms` opts.reasons). `min_stay` carries the nights
 *  required so a caller can suggest a stay that would work. */
export interface GateReason {
  roomId: string;
  roomTitle: string;
  rateId?: string;
  rateTitle?: string;
  reason: "sold_out" | "stop_sell" | "min_stay" | "closed_to_arrival" | "closed_to_departure";
  minNights?: number;
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
  opts: { gate?: boolean; reasons?: GateReason[] } = {},
): Promise<RoomWithRates[]> {
  const gate = opts.gate ?? false;
  // Collected rather than returned: a room whose every rate is gated out is
  // dropped from the result entirely, so there is nowhere left to hang the
  // explanation. The guest UI ignores this; the API uses it to tell a caller
  // WHY something isn't bookable instead of having it silently vanish.
  const note = (r: GateReason) => opts.reasons?.push(r);
  const [rooms, rates, promotions, settings] = await Promise.all([
    getRooms(pid),
    getRates(pid),
    getPromotions(pid),
    // For the cancellation anchor: a rate card's free-until date has to be the
    // same moment the booking will snapshot, and that needs the hotel's cut-off
    // time and timezone.
    getSettings(pid),
  ]);
  const { checkinDate, checkoutDate, currency: cur } = query;
  const cancelAnchor = { time: settings.cancelAnchorTime, timezone: settings.timezone };
  // Property-wide pricing mode — every rate prices per room or per person.
  const perPersonMode = pricingModeOf(settings, rates) === "per_person";
  // Searched party — drives per-person (occupancy) rate pricing below.
  const childrenAge = query.childrenAge ?? [];
  const nights =
    checkinDate && checkoutDate
      ? Math.max(1, differenceInCalendarDays(parseISO(checkoutDate), parseISO(checkinDate)))
      : 1;
  // Best automatic offer for this stay (early bird / last-minute / length-of-stay),
  // baked into each rate price below so the sale shows consistently on results,
  // detail, cart, checkout and confirmation (all of which call this function).
  const daysAhead = checkinDate
    ? differenceInCalendarDays(parseISO(checkinDate), parseISO(format(new Date(), "yyyy-MM-dd")))
    : 0;
  // One context, two independent questions: which discount is best, and what's
  // included. `bestAutoOffer` returns null when a matching value-add is
  // exclusive, so the suppression lives in one place rather than here.
  const stayCtx = { daysAhead, nights, checkin: checkinDate, checkout: checkoutDate };
  const offer = checkinDate ? bestAutoOffer(promotions, stayCtx) : null;
  const valueAdds = checkinDate ? valueAddViews(promotions, stayCtx) : [];
  const currency = cur || "GBP";
  // The nights occupied by the stay: checkin .. checkout-1.
  const nightDates = checkinDate
    ? Array.from({ length: nights }, (_, i) => format(addDays(parseISO(checkinDate), i), "yyyy-MM-dd"))
    : [];
  // Query through the checkout date too, so the CTD check below sees it.
  const inv = nightDates.length
    ? await getInventory(pid, nightDates[0], checkoutDate ?? nightDates[nightDates.length - 1])
    : { availability: {}, prices: {}, pricesByOcc: {}, restrictions: {} };

  return rooms
    .map((room): RoomWithRates => {
      const occupancy = {
        adults: room.maxAdults,
        children: Math.max(0, room.maxGuests - room.maxAdults),
        infants: 0,
      };
      // Room availability = the lowest nightly count over the stay. A night with
      // no inventory row counts as 0 (not bookable) — owners must set availability
      // before a room can be sold. (No dates selected = nothing to gate on.)
      let roomAvail = Infinity;
      for (const d of nightDates) {
        roomAvail = Math.min(roomAvail, inv.availability[`${room.id}|${d}`] ?? 0);
      }
      const soldOut = gate && nightDates.length > 0 && roomAvail <= 0;
      if (soldOut) note({ roomId: room.id, roomTitle: room.title, reason: "sold_out" });
      const availForRate = Number.isFinite(roomAvail) ? roomAvail : 99;

      const ratePlans = soldOut
        ? []
        : rates
            .filter((r) => r.active && r.prices[room.id] !== undefined)
            .map((r): RatePlan | null => {
              const base = r.prices[room.id];
              const pol = ratePolicyOf(r);
              // The same computation the booking will snapshot, so the free-until
              // date on the rate card can't disagree with the confirmation email.
              const freeCancel = policyToCancellation(pol, checkinDate, cancelAnchor);
              // ARI is keyed by the room's real Channex rate id, which for a
              // consolidated imported rate differs from our single `r.id`.
              const k = (d: string) => `${room.id}|${rateChannexId(r, room.id)}|${d}`;
              if (gate) {
                const where = { roomId: room.id, roomTitle: room.title, rateId: r.id, rateTitle: r.title };
                if (nightDates.some((d) => inv.restrictions[k(d)]?.stopSell)) {
                  note({ ...where, reason: "stop_sell" });
                  return null;
                }
                const minStay = (checkinDate && inv.restrictions[k(checkinDate)]?.minStay) || 1;
                if (nights < minStay) {
                  note({ ...where, reason: "min_stay", minNights: minStay });
                  return null;
                }
                if (checkinDate && inv.restrictions[k(checkinDate)]?.cta) {
                  note({ ...where, reason: "closed_to_arrival" });
                  return null; // closed to arrival
                }
                if (checkoutDate && inv.restrictions[k(checkoutDate)]?.ctd) {
                  note({ ...where, reason: "closed_to_departure" });
                  return null; // closed to departure
                }
              }
              // Occupancy pricing: adjust each night for the searched party. With
              // no adults given, price at the rate's default occupancy (no delta).
              // A per-room override wins over the rate-wide default when present.
              const op = r.occupancyPricingByRoom?.[room.id] ?? r.occupancyPricing;
              const adults = query.adults && query.adults > 0 ? query.adults : (op?.defaultOccupancy ?? 1);
              // A PER-PERSON rate prices adults from the per-occupancy ARI rows
              // (per-adult × adults where only a manual/base price exists) and
              // children from the age bands alone; everything else keeps the
              // flat price + occupancy delta model.
              const nightlyFor = (nAdults: number, d?: string): number => {
                if (perPersonMode) {
                  const byOcc = d ? inv.pricesByOcc[k(d)] : undefined;
                  return perPersonPrice(byOcc, nAdults) ?? base * Math.max(1, nAdults);
                }
                const invPrice = d ? inv.prices[k(d)] : undefined;
                return (invPrice ?? base) + occupancyNightlyDelta(op, nAdults, []);
              };
              const childDelta = childrenNightlyDelta(op, childrenAge);
              // Effective nightly price for the stay: the ARI price when set, else
              // the rate's base. A night priced at 0 means no rate is loaded (or
              // it's free) — we don't sell free rooms, so any unpriced night makes
              // the rate unbookable (and a room with no priced rate drops out).
              const nightly = nightDates.length
                ? nightDates.map((d) => nightlyFor(adults, d) + childDelta)
                : [nightlyFor(adults) + childDelta];
              if (nightly.some((n) => n <= 0)) return null;
              // Room-only stay totals for every party size, so the detail page
              // can re-price live as the guest changes adults — a per-person
              // rate's prices vary by date, so a flat per-night delta can't
              // express them the way `occupancyPricing` does for flat rates.
              const perPersonTotals: Record<number, number> | undefined = perPersonMode
                ? Object.fromEntries(
                    Array.from({ length: Math.max(1, room.maxAdults) }, (_, i) => {
                      const n = i + 1;
                      const tot = nightDates.length
                        ? nightDates.reduce((s, d) => s + nightlyFor(n, d), 0)
                        : nightlyFor(n) * nights;
                      return [n, Math.round(tot * 100) / 100];
                    }),
                  )
                : undefined;
              const raw = nightDates.length ? nightly.reduce((s, n) => s + n, 0) : nightly[0] * nights;
              const gross = Math.round(raw * 100) / 100;
              const sale = offer ? Math.round(gross * (1 - offer.value / 100) * 100) / 100 : gross;
              const total = sale.toFixed(2);
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
                cancellationNote: pol.overrideNote || undefined,
                refundable: pol.cancellation.refundable,
                freeCancelUntilISO: freeCancel.cancelByISO,
                freeCancelUntilLocal: freeCancel.cancelByLocal,
                offer: offer
                  ? {
                      name: offer.name || "Offer",
                      percent: offer.value,
                      originalTotalPrice: gross.toFixed(2),
                    }
                  : undefined,
                valueAdds: valueAdds.length ? valueAdds : undefined,
                occupancyPricing: op,
                perPerson: perPersonMode || undefined,
                perPersonTotals,
              };
            })
            .filter((rp): rp is RatePlan => rp !== null);

      return {
        id: room.id,
        title: room.title,
        description: room.description,
        facilities: room.facilities,
        amenities: room.amenities ?? [],
        photos: room.images.map((url) => ({ url })),
        cleaningFee: room.cleaningFee,
        ratePlans,
      };
    })
    .filter((room) => room.ratePlans.length > 0);
}

/** Resolve cart lines to priced lines, honouring each line's own occupancy.
 *  Lines are grouped by occupancy and priced via getCatalogRooms once per group
 *  (so per-room party pricing, offers and ARI all apply consistently); a line
 *  with no occupancy falls back to the searched party. Order is preserved. */
export async function resolveCartByOccupancy(
  pid: string,
  stay: { checkin: string; checkout: string; currency: string },
  lines: CartLine[],
  searched: { adults: number; childrenAge: number[] },
): Promise<ResolvedLine[]> {
  const occOf = (l: CartLine) => lineOccupancy(l, searched);
  const sig = (o: { adults: number; childrenAge: number[] }) =>
    `${o.adults}|${[...o.childrenAge].sort((a, b) => a - b).join(".")}`;

  const groups = new Map<string, { adults: number; childrenAge: number[] }>();
  for (const l of lines) groups.set(sig(occOf(l)), occOf(l));

  const roomsByGroup = new Map<string, RoomWithRates[]>();
  for (const [key, occ] of groups) {
    roomsByGroup.set(
      key,
      await getCatalogRooms(
        pid,
        {
          checkinDate: stay.checkin,
          checkoutDate: stay.checkout,
          currency: stay.currency,
          adults: occ.adults,
          childrenAge: occ.childrenAge,
        },
        { gate: true },
      ),
    );
  }

  const out: ResolvedLine[] = [];
  for (const l of lines) {
    const occ = occOf(l);
    const rooms = roomsByGroup.get(sig(occ));
    const room = rooms?.find((r) => r.id === l.roomId);
    const rate = room?.ratePlans.find((p) => p.id === l.rateId);
    if (room && rate) {
      // Hard capacity ceiling: a line can never claim more heads than the room
      // physically sleeps, whatever the `sel` string asked for (bare/deep/stale
      // links included). Keeps coverage honest — an over-sized party yields
      // "Sleeps N of M" and blocks checkout instead of a false "Sleeps all".
      const cap = roomCapacity(room);
      const adults = Math.min(occ.adults, cap.maxAdults);
      const children = Math.min(occ.childrenAge.length, Math.max(0, cap.capacity - adults));
      out.push({
        roomId: l.roomId,
        rateId: l.rateId,
        adults: l.adults,
        childrenAge: l.childrenAge,
        roomTitle: room.title,
        rateTitle: rate.title,
        occupancy: { adults, children, infants: 0 },
        total: Number(rate.totalPrice),
        net: Number(rate.netPrice ?? rate.totalPrice),
        cleaningFee: Number(room.cleaningFee ?? 0),
        photo: room.photos?.[0]?.url,
        originalTotal: rate.offer ? Number(rate.offer.originalTotalPrice) : Number(rate.totalPrice),
        offerName: rate.offer?.name,
        offerPercent: rate.offer?.percent,
        valueAdds: rate.valueAdds,
      });
    }
  }
  return out;
}

/** Calendar availability for [from, to] (inclusive), in the Channex ClosedDates
 *  shape the date picker consumes. A date is closed when no room is bookable
 *  (availability 0, or every active rate stop-sold); closedToArrival/Departure
 *  when every otherwise-bookable rate is closed to arrival/departure that day;
 *  minStayArrival is the smallest min-stay among the bookable rates. Dates with
 *  no inventory row are closed (not bookable, same as the booking flow). */
export async function getCalendarAvailability(
  pid: string,
  from: string,
  to: string,
  /** Limit to one room — the room page's calendar answers "when is THIS room
   *  free?", which is a different question from the search calendar's "when is
   *  anything free?". Same gate either way, so the two can't disagree. */
  opts: { roomId?: string } = {},
): Promise<ClosedDates> {
  const [allRooms, rates, inv] = await Promise.all([getRooms(pid), getRates(pid), getInventory(pid, from, to)]);
  const rooms = opts.roomId ? allRooms.filter((r) => r.id === opts.roomId) : allRooms;
  const ratesByRoom = new Map<string, CatalogRate[]>();
  for (const r of rates) {
    if (!r.active) continue;
    // A rate is offered on every room it has a price for.
    for (const roomId of Object.keys(r.prices)) {
      (ratesByRoom.get(roomId) ?? ratesByRoom.set(roomId, []).get(roomId)!).push(r);
    }
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
      const avail = inv.availability[`${room.id}|${date}`] ?? 0;
      if (avail <= 0) continue; // no inventory set = not bookable
      for (const rt of roomRates) {
        // getInventory keys restrictions/prices by room|rate|date (see
        // ari.server.ts) — the old rate|date key never matched, so the calendar
        // showed stop-sell/CTA/CTD/min-stay dates as open. Match the booking
        // gate's key exactly.
        const rid = rateChannexId(rt, room.id);
        const r = inv.restrictions[`${room.id}|${rid}|${date}`];
        if (r?.stopSell) continue; // rate not bookable this day
        // A night with no price (or 0) isn't for sale — mirror getCatalogRooms
        // so the calendar doesn't offer a date the results page will reject.
        if ((inv.prices[`${room.id}|${rid}|${date}`] ?? rt.prices[room.id]) <= 0) continue;
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
