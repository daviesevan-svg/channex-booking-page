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
  DEFAULT_MAX_AGE_HOURS,
  DEFAULT_MIN_SAVING_PCT,
  type DirectCompareBadge,
  type OtaQuote,
} from "./direct-compare";
import { getCompSet } from "./revman-compset.server";
import { getRoomPrices } from "./revman-room-prices.server";
import { stayTotalMinor } from "./revman-room-prices";

export interface CompareSettings {
  /** Off until the property turns it on: it publishes a claim about a third
   *  party's price, so it is never on by default. */
  enabled: boolean;
  /** Our room id → Booking room ref. Rooms absent from here get no badge. */
  roomMap: Record<string, string>;
  minSavingPct: number;
  maxAgeHours: number;
}

export const DEFAULT_COMPARE_SETTINGS: CompareSettings = {
  enabled: false,
  roomMap: {},
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
