// Reading a property's Booking.com room mapping out of Channex, so the price
// comparison doesn't need the owner to re-enter a mapping their channel manager
// already holds.
//
// Read-only: it lists the property's channels and reads the Booking.com one. It
// never creates, updates or activates a channel, and never touches Booking
// directly. The result is presented for review — nothing is saved until the
// owner saves the form.
import { getConfig } from "../config.server";
import { getRevmanChannexAuth } from "../revman.server";
import { getAriRatePairs } from "../revman-rate-link.server";
import {
  codeOverlap,
  composeRoomMap,
  keepKnownCodes,
  pickBookingChannel,
  type BookingChannel,
} from "./bcom-mapping";

/** Channex's Booking.com channel identifier. */
const BOOKING_CHANNEL = "BookingCom";

/** A Booking.com channel we found, for the owner to see what was considered. */
export interface FoundChannel {
  title?: string;
  hotelId?: string;
  isActive?: boolean;
  /** How many of its Booking rooms we've captured prices for. */
  overlap: number;
}

export interface ImportedRoomMap {
  ok: boolean;
  /** Our room id → Booking room code, ready to pre-fill the mapping form. */
  roomMap: Record<string, string>;
  /** The channel we read, for the owner to recognise. */
  channelTitle?: string;
  /** Booking's hotel id from the channel settings. */
  hotelId?: string;
  /** Every Booking.com channel on the property — shown when the choice matters. */
  channels: FoundChannel[];
  /** How the channel was chosen (or why none could be). */
  pickedBy?: string;
  /** Rooms whose rate plans point at different Booking rooms — not mapped. */
  conflicts: { roomId: string; codes: string[] }[];
  /** Mappings dropped because we hold no captured room with that code. */
  dropped: { roomId: string; code: string }[];
  error?: string;
}

const EMPTY: ImportedRoomMap = { ok: false, roomMap: {}, channels: [], conflicts: [], dropped: [] };

interface ChannelEnvelope {
  data?: {
    id?: string;
    attributes?: {
      id?: string;
      title?: string;
      channel?: string;
      is_active?: boolean;
      properties?: string[];
      settings?: { hotel_id?: string | number };
      rate_plans?: { rate_plan_id?: string; settings?: { room_type_code?: string | number } }[];
    };
  };
}

interface ChannelListEnvelope {
  data?: { id?: string; attributes?: { id?: string; channel?: string; title?: string } }[];
}

/** Channex is behind an admin button, so a slow or unreachable API must fail
 *  fast rather than hold the request open. */
const REQUEST_TIMEOUT_MS = 10_000;
/** A property shouldn't have many channels; bound the detail fetches so a large
 *  account can't turn one click into dozens of round trips. */
const MAX_CHANNELS_INSPECTED = 12;

async function channexGet<T>(path: string, apiKey: string): Promise<T | null> {
  const base = getConfig().apiUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "user-api-key": apiKey, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Channex returned ${res.status}`);
    return (await res.json().catch(() => null)) as T | null;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("Channex did not respond in time.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the property's Booking.com channel and composes the room mapping.
 *  `knownCodes` are the Booking room ids we have actually captured — they both
 *  decide WHICH channel to read when a property has several Booking.com
 *  connections, and filter the result, since a mapping we can't compare against
 *  would look like it works while never showing a badge.
 *  `preferredHotelId` pins the choice explicitly and overrides that inference. */
export async function importBookingRoomMap(
  pid: string,
  knownCodes: string[],
  preferredHotelId?: string,
): Promise<ImportedRoomMap> {
  const auth = await getRevmanChannexAuth(pid).catch(() => undefined);
  if (!auth) return { ...EMPTY, error: "not_connected" };

  let listed: ChannelListEnvelope | null;
  try {
    listed = await channexGet<ChannelListEnvelope>("/api/v1/channels", auth.apiKey);
  } catch (err) {
    return { ...EMPTY, error: String(err instanceof Error ? err.message : err) };
  }
  const candidates = (listed?.data ?? []).filter(
    (c) => !c.attributes?.channel || c.attributes.channel === BOOKING_CHANNEL,
  );
  if (candidates.length === 0) return { ...EMPTY, error: "no_channel" };

  // The list response doesn't always carry `channel` or `properties`, so confirm
  // on the detail fetch: the channel must be Booking.com AND cover this property.
  // ALL of them are collected, not just the first — a property can have more than
  // one Booking.com connection (a second listing, a legacy one), and reading the
  // wrong one would map our rooms to another listing's rooms.
  const found: BookingChannel[] = [];
  let lastDetailError: string | undefined;
  for (const c of candidates.slice(0, MAX_CHANNELS_INSPECTED)) {
    const id = c.id ?? c.attributes?.id;
    if (!id) continue;
    let detail: ChannelEnvelope | null;
    try {
      detail = await channexGet<ChannelEnvelope>(`/api/v1/channels/${id}`, auth.apiKey);
    } catch (err) {
      lastDetailError = String(err instanceof Error ? err.message : err);
      continue;
    }
    const a = detail?.data?.attributes;
    if (!a || a.channel !== BOOKING_CHANNEL) continue;
    const props = a.properties ?? [];
    if (props.length > 0 && !props.includes(auth.channexPropertyId)) continue;
    found.push({
      channelId: String(id),
      title: a.title,
      hotelId: a.settings?.hotel_id === undefined || a.settings?.hotel_id === null ? undefined : String(a.settings.hotel_id),
      isActive: a.is_active,
      ratePlans: (a.rate_plans ?? []).map((rp) => ({
        ratePlanId: String(rp.rate_plan_id ?? ""),
        roomTypeCode:
          rp.settings?.room_type_code === undefined || rp.settings?.room_type_code === null
            ? null
            : String(rp.settings.room_type_code),
      })),
    });
  }
  // A channel we couldn't read is not the same as a channel that isn't there —
  // saying "no Booking.com channel" would send the owner looking for the wrong
  // problem.
  if (found.length === 0) return { ...EMPTY, error: lastDetailError ?? "no_channel" };

  const channels = found.map((c) => ({
    title: c.title,
    hotelId: c.hotelId,
    isActive: c.isActive,
    /** How many of its Booking rooms we've actually captured — why it won or lost. */
    overlap: codeOverlap(c, knownCodes),
  }));

  const pick = pickBookingChannel(found, knownCodes, preferredHotelId);
  if (!pick.chosen) return { ...EMPTY, channels, error: pick.reason };
  const matched = pick.chosen;

  const channelRates = matched.ratePlans;
  if (channelRates.every((r) => !r.roomTypeCode)) {
    return { ...EMPTY, channels, channelTitle: matched.title, hotelId: matched.hotelId, error: "not_mapped" };
  }

  // Which of our rooms each rate plan prices, from our own ARI. A wide window so
  // rate plans that only sell a future season still resolve.
  const today = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  const pairs = await getAriRatePairs(pid, today, to).catch(() => []);

  const composed = composeRoomMap(channelRates, pairs);
  const { kept, dropped } = keepKnownCodes(composed.roomMap, knownCodes);
  const ok = Object.keys(kept).length > 0;
  // Two different "nothing matched" causes, and they need different fixes:
  // the channel prices rate plans we don't hold (usually a different property or
  // an unsynced rate plan), versus it maps to Booking rooms we've never captured
  // (usually a different Booking listing than the comp set's own row).
  const error = ok
    ? undefined
    : composed.unknownRatePlans.length > 0 && Object.keys(composed.roomMap).length === 0
      ? "rates_unknown"
      : "no_match";
  return {
    ok,
    roomMap: kept,
    channelTitle: matched.title,
    hotelId: matched.hotelId,
    channels,
    pickedBy: pick.reason,
    conflicts: composed.conflicts,
    dropped,
    error,
  };
}
