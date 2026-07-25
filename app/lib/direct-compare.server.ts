// Server side of the "cheaper direct" badge: per-property settings, the mapping
// from our room types to Booking's, and the lookup the booking page runs.
//
// The rules live in direct-compare.ts; this module's job is to feed them and to
// make sure a booking page NEVER pays for the feature being unavailable — every
// path here degrades to "no badge" on any failure, and the whole thing is off
// until a property opts in.
import { getConfigKV } from "./config.server";
import {
  compareDirect,
  toBadge,
  type CompareSkip,
  DEFAULT_MAX_AGE_HOURS,
  DEFAULT_MIN_SAVING_PCT,
  type DirectCompareBadge,
  type OtaQuote,
} from "./direct-compare";
import { getCompSet } from "./revman-compset.server";
import { getRoomPrices } from "./revman-room-prices.server";
import { stayTotalMinor } from "./revman-room-prices";
import { computePricing, taxConfigFrom } from "./pricing";
import { ratePlansForParty } from "./occupancy";
import { getCatalogRooms } from "./catalog.server";
import { getSettings } from "./overrides.server";

export interface CompareSettings {
  /** Off until the property turns it on: it publishes a claim about a third
   *  party's price, so it is never on by default. */
  enabled: boolean;
  /** Our room id → Booking room ref. Rooms absent from here get no badge. */
  roomMap: Record<string, string>;
  /** Booking's hotel id, to pin WHICH Booking.com channel the mapping is read
   *  from when a property has more than one connection. Blank = infer it from
   *  the room codes we've captured. */
  bookingHotelId: string;
  minSavingPct: number;
  maxAgeHours: number;
}

export const DEFAULT_COMPARE_SETTINGS: CompareSettings = {
  enabled: false,
  roomMap: {},
  bookingHotelId: "",
  minSavingPct: DEFAULT_MIN_SAVING_PCT,
  maxAgeHours: DEFAULT_MAX_AGE_HOURS,
};

const KEY = (pid: string) => `revcompare:${pid}`;

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Only string→string pairs survive a read, so a hand-edited or older shape
 *  can't put objects into the map the booking page reads. */
function cleanMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

export async function getCompareSettings(pid: string): Promise<CompareSettings> {
  const raw = await getConfigKV()?.get(KEY(pid));
  if (!raw) return { ...DEFAULT_COMPARE_SETTINGS, roomMap: {} };
  try {
    const s = JSON.parse(raw) as Partial<CompareSettings>;
    return {
      enabled: Boolean(s.enabled),
      roomMap: cleanMap(s.roomMap),
      bookingHotelId: typeof s.bookingHotelId === "string" ? s.bookingHotelId.trim() : "",
      minSavingPct: clampInt(s.minSavingPct, 1, 50, DEFAULT_MIN_SAVING_PCT),
      maxAgeHours: clampInt(s.maxAgeHours, 1, 720, DEFAULT_MAX_AGE_HOURS),
    };
  } catch {
    return { ...DEFAULT_COMPARE_SETTINGS, roomMap: {} };
  }
}

export async function setCompareSettings(pid: string, patch: Partial<CompareSettings>): Promise<CompareSettings> {
  const current = await getCompareSettings(pid);
  const next: CompareSettings = {
    enabled: patch.enabled ?? current.enabled,
    roomMap: patch.roomMap ? cleanMap(patch.roomMap) : current.roomMap,
    bookingHotelId:
      patch.bookingHotelId !== undefined ? String(patch.bookingHotelId).trim() : current.bookingHotelId,
    minSavingPct:
      patch.minSavingPct !== undefined ? clampInt(patch.minSavingPct, 1, 50, current.minSavingPct) : current.minSavingPct,
    maxAgeHours:
      patch.maxAgeHours !== undefined ? clampInt(patch.maxAgeHours, 1, 720, current.maxAgeHours) : current.maxAgeHours,
  };
  await getConfigKV()?.put(KEY(pid), JSON.stringify(next));
  return next;
}

/** The Booking room types we last captured for our own hotel, newest first —
 *  the options the owner picks from when mapping. */
export async function ownOtaRooms(
  pid: string,
  from: string,
  to: string,
): Promise<{ roomRef: string; name: string; maxPersons: number | null }[]> {
  const set = await getCompSet(pid);
  const selfId = set.ranked.find((h) => h.isSelf)?.id;
  if (!selfId) return [];
  const rows = await getRoomPrices(pid, selfId, from, to);
  const byRef = new Map<string, { roomRef: string; name: string; maxPersons: number | null }>();
  for (const r of rows) byRef.set(r.roomRef, { roomRef: r.roomRef, name: r.roomName, maxPersons: r.maxPersons });
  return [...byRef.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Builds the all-in (tax- and fee-inclusive) total for a stay. Exported so the
 *  booking page and the "why isn't it showing?" checker compute our direct price
 *  the SAME way — if they drifted, the checker would confidently explain a
 *  comparison the page never made. */
export function allInFactory(
  settings: Parameters<typeof taxConfigFrom>[0],
  stay: { nights: number; adults: number; children: number; checkin: string },
): (base: number, cleaningFee: number) => number {
  const taxConfig = taxConfigFrom(settings);
  return (base, cleaningFee) =>
    Math.round(
      computePricing(
        { base, nights: stay.nights, adults: stay.adults, children: stay.children, rooms: 1, cleaningFee, taxableExtras: 0, checkin: stay.checkin },
        taxConfig,
      ).total * 100,
    ) / 100;
}

/** Our cheapest all-in total for a room, in minor units — the figure behind the
 *  card's "from …" price, and the only thing the comparison should ever use.
 *  Null when the room has no rate for this party. */
export function cheapestDirectMinor(
  room: { ratePlans: { totalPrice: string | number; allInTotal?: number }[] },
  party: number,
  allIn?: (base: number, cleaningFee: number) => number,
  cleaningFee = 0,
): number | null {
  const rates = ratePlansForParty(room as never, party);
  if (rates.length === 0) return null;
  const totals = rates.map((rp) => {
    const withAllIn = rp as { totalPrice: string; allInTotal?: number };
    if (withAllIn.allInTotal !== undefined) return withAllIn.allInTotal;
    return allIn ? allIn(Number(withAllIn.totalPrice), cleaningFee) : Number(withAllIn.totalPrice);
  });
  const best = Math.min(...totals);
  return Number.isFinite(best) && best > 0 ? Math.round(best * 100) : null;
}

/** Badges for a search, keyed by OUR room id. Returns an empty map whenever the
 *  feature is off, unmapped, or anything at all goes wrong — the booking page
 *  renders exactly as it did before in that case.
 *
 *  `directTotals` are our all-in totals for the whole stay, which is what the
 *  card shows; Booking's equivalent comes from the stay-length totals captured
 *  for the check-in date, so a 3-night search compares against Booking's own
 *  3-night price rather than a nightly rate multiplied out. */
export async function directCompareBadges(
  pid: string,
  opts: { checkin: string; nights: number; currency: string; directTotals: Record<string, number> },
): Promise<Record<string, DirectCompareBadge>> {
  const out: Record<string, DirectCompareBadge> = {};
  try {
    const roomIds = Object.keys(opts.directTotals);
    if (roomIds.length === 0 || opts.nights < 1) return out;

    const settings = await getCompareSettings(pid);
    if (!settings.enabled) return out;
    const mapped = roomIds.filter((id) => settings.roomMap[id]);
    if (mapped.length === 0) return out;

    const set = await getCompSet(pid);
    const selfId = set.ranked.find((h) => h.isSelf)?.id;
    if (!selfId) return out;

    // One indexed read: our own hotel's rooms on the check-in date.
    const rows = await getRoomPrices(pid, selfId, opts.checkin, opts.checkin);
    if (rows.length === 0) return out;
    const byRef = new Map(rows.map((r) => [r.roomRef, r]));

    const nowMs = Date.now();
    for (const roomId of mapped) {
      const row = byRef.get(settings.roomMap[roomId]);
      // Compare cheapest-to-cheapest: our card's "from" price against the
      // cheapest way to book that room on Booking, which is what a shopper
      // checking both sites would see.
      const quote: OtaQuote | null = row
        ? {
            totalMinor: stayTotalMinor({ stays: row.stays }, opts.nights),
            currency: row.currency ?? opts.currency,
            allIncluded: row.allIncluded,
            mealPlan: row.mealPlan,
            refundable: row.flexPriceMinor !== null && row.flexPriceMinor === row.priceMinor,
            capturedAt: row.capturedAt,
          }
        : null;
      const badge = toBadge(
        compareDirect({
          directTotalMinor: Math.round(opts.directTotals[roomId]),
          currency: opts.currency,
          ota: quote,
          nowMs,
          minSavingPct: settings.minSavingPct,
          maxAgeHours: settings.maxAgeHours,
        }),
        opts.nights,
      );
      if (badge) out[roomId] = badge;
    }
  } catch (err) {
    console.error(`[direct-compare] badges unavailable for ${pid}`, err);
    return {};
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Why isn't the badge showing?"
//
// The badge is deliberately silent, which makes it undiagnosable: an owner sees
// nothing and can't tell whether the price is stale, the room is unmapped, or
// they simply aren't cheaper. compareDirect already computes exactly one reason
// per room — this surfaces it instead of discarding it.

export interface CompareExplainRow {
  roomId: string;
  roomTitle: string;
  /** Booking room code this room is mapped to, if any. */
  otaRoomRef: string | null;
  otaRoomName: string | null;
  /** Our cheapest all-in total for the stay, minor units. */
  directTotalMinor: number | null;
  /** Booking's total for the same stay + room, minor units. */
  otaTotalMinor: number | null;
  capturedAt: string | null;
  /** Set when the badge WOULD show. */
  savingPct?: number;
  /** Set when it wouldn't — one of the CompareSkip reasons, or "unmapped". */
  skip?: CompareSkip | "unmapped" | "no_rate";
}

export interface CompareExplain {
  enabled: boolean;
  currency: string;
  nights: number;
  minSavingPct: number;
  maxAgeHours: number;
  rows: CompareExplainRow[];
}

/** Runs the real comparison for one stay and reports, per room, what the booking
 *  page would do and why. Uses the same rooms, the same all-in arithmetic and the
 *  same rules as the page, so its answer IS the page's answer. */
export async function explainDirectCompare(
  pid: string,
  stay: { checkin: string; nights: number; adults: number },
): Promise<CompareExplain> {
  const nights = Math.max(1, Math.round(stay.nights));
  const adults = Math.max(1, Math.round(stay.adults));
  const checkout = new Date(Date.parse(`${stay.checkin}T00:00:00Z`) + nights * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const [settings, compare, set] = await Promise.all([getSettings(pid), getCompareSettings(pid), getCompSet(pid)]);
  const currency = settings.currency || "GBP";
  const base: CompareExplain = {
    enabled: compare.enabled,
    currency,
    nights,
    minSavingPct: compare.minSavingPct,
    maxAgeHours: compare.maxAgeHours,
    rows: [],
  };

  const rooms = await getCatalogRooms(
    pid,
    { checkinDate: stay.checkin, checkoutDate: checkout, currency, adults },
    { gate: true },
  );
  const allIn = allInFactory(settings, { nights, adults, children: 0, checkin: stay.checkin });

  const selfId = set.ranked.find((h) => h.isSelf)?.id;
  const captured = selfId ? await getRoomPrices(pid, selfId, stay.checkin, stay.checkin) : [];
  const byRef = new Map(captured.map((r) => [r.roomRef, r]));
  const nowMs = Date.now();

  for (const room of rooms) {
    const roomRef = compare.roomMap[room.id] ?? null;
    const directTotalMinor = cheapestDirectMinor(room, adults, allIn, room.cleaningFee ?? 0);
    const row: CompareExplainRow = {
      roomId: room.id,
      roomTitle: room.title,
      otaRoomRef: roomRef,
      otaRoomName: roomRef ? (byRef.get(roomRef)?.roomName ?? null) : null,
      directTotalMinor,
      otaTotalMinor: null,
      capturedAt: null,
    };
    if (!roomRef) {
      row.skip = "unmapped";
      base.rows.push(row);
      continue;
    }
    if (directTotalMinor === null) {
      row.skip = "no_rate";
      base.rows.push(row);
      continue;
    }
    const captureRow = byRef.get(roomRef);
    const quote: OtaQuote | null = captureRow
      ? {
          totalMinor: stayTotalMinor({ stays: captureRow.stays }, nights),
          currency: captureRow.currency ?? currency,
          allIncluded: captureRow.allIncluded,
          mealPlan: captureRow.mealPlan,
          refundable: captureRow.flexPriceMinor !== null && captureRow.flexPriceMinor === captureRow.priceMinor,
          capturedAt: captureRow.capturedAt,
        }
      : null;
    row.otaTotalMinor = quote?.totalMinor ?? null;
    row.capturedAt = quote?.capturedAt ?? null;

    const result = compareDirect({
      directTotalMinor,
      currency,
      ota: quote,
      nowMs,
      minSavingPct: compare.minSavingPct,
      maxAgeHours: compare.maxAgeHours,
    });
    if (result.show) row.savingPct = result.savingPct;
    else row.skip = result.skip;
    base.rows.push(row);
  }
  return base;
}
