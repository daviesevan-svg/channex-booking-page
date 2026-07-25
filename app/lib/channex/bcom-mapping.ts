// Composing our room types → Booking.com room ids from a Channex Booking.com
// channel. Pure, so the composition can be tested without the network.
//
// A Channex Booking.com channel stores its mapping per RATE PLAN, not per room:
// each of our rate plans carries `settings.room_type_code` (Booking's room id)
// and `settings.rate_plan_code`. Since a rate plan belongs to exactly one room
// type, and our own ARI tells us which room each rate plan prices, the two
// compose into the room-level mapping the price comparison needs.
//
// Booking's `room_type_code` is the same id the hotel page exposes as a room's
// `b_id` — both are Booking's room-type code, formed as {hotel id}{2-digit room
// index} (Channex's own docs pair hotel_id "5868189" with room_type_code
// "586818903"; the Spilman listing scrapes as 36364‑01/04/06/09/10/12 against
// hotel 36364). Where a code doesn't match anything we captured, the room is
// reported unmatched rather than mapped to a guess.

/** A Booking.com channel on the property, reduced to what identifies it. */
export interface BookingChannel {
  channelId: string;
  title?: string;
  /** Booking's hotel id from the channel settings. */
  hotelId?: string;
  isActive?: boolean;
  ratePlans: ChannelRatePlan[];
}

/** How a channel was chosen, or why none could be. */
export type ChannelPick =
  /** The owner pinned a Booking hotel id and it matched. */
  | { reason: "hotel_id"; chosen: BookingChannel }
  /** Its mapped room codes match the rooms we've scraped — nothing else does. */
  | { reason: "code_overlap"; chosen: BookingChannel }
  /** Only one Booking.com channel exists, so there's nothing to disambiguate. */
  | { reason: "only_one"; chosen: BookingChannel }
  /** No Booking.com channel at all. */
  | { reason: "none"; chosen: null }
  /** A hotel id was pinned but no channel carries it. */
  | { reason: "hotel_id_not_found"; chosen: null }
  /** Several channels, and the scraped room codes don't single one out. */
  | { reason: "ambiguous"; chosen: null };

/** How many of a channel's mapped Booking room codes we have actually captured
 *  prices for. This is what lets two Booking.com connections on one property be
 *  told apart without asking: the right channel is the one whose rooms are the
 *  rooms we're scraping. */
export function codeOverlap(channel: BookingChannel, knownCodes: string[]): number {
  const known = new Set(knownCodes);
  const codes = new Set(
    channel.ratePlans.map((r) => (r.roomTypeCode ?? "").trim()).filter(Boolean),
  );
  let n = 0;
  for (const c of codes) if (known.has(c)) n++;
  return n;
}

/** Chooses which Booking.com channel to read the mapping from.
 *
 *  A pinned hotel id always wins — it's the owner being explicit. Otherwise the
 *  scraped room codes decide, which handles the common case of a property with
 *  more than one Booking.com connection (a second listing, a legacy connection)
 *  without making anyone dig ids out of Channex. A tie, or no overlap at all, is
 *  reported as ambiguous rather than resolved by picking the first: reading the
 *  wrong connection would map our rooms to another listing's rooms and quote a
 *  completely unrelated price to a guest. */
export function pickBookingChannel(
  channels: BookingChannel[],
  knownCodes: string[],
  preferredHotelId?: string,
): ChannelPick {
  if (channels.length === 0) return { reason: "none", chosen: null };

  const pinned = (preferredHotelId ?? "").trim();
  if (pinned) {
    const hit = channels.find((c) => (c.hotelId ?? "").trim() === pinned);
    return hit ? { reason: "hotel_id", chosen: hit } : { reason: "hotel_id_not_found", chosen: null };
  }

  if (channels.length === 1) return { reason: "only_one", chosen: channels[0] };

  const scored = channels
    .map((c) => ({ channel: c, overlap: codeOverlap(c, knownCodes) }))
    .sort((a, b) => b.overlap - a.overlap);
  const best = scored[0];
  const runnerUp = scored[1];
  if (best.overlap === 0) return { reason: "ambiguous", chosen: null };
  if (runnerUp && runnerUp.overlap === best.overlap) return { reason: "ambiguous", chosen: null };
  return { reason: "code_overlap", chosen: best.channel };
}

/** One rate plan's Booking mapping, as stored on a Channex channel. */
export interface ChannelRatePlan {
  /** OUR Channex rate-plan id. */
  ratePlanId: string;
  /** Booking's room-type code, or null when that rate plan isn't mapped. */
  roomTypeCode: string | null;
}

/** A (room, rate) pair that exists in our own ARI. */
export interface RoomRatePair {
  roomId: string;
  rateId: string;
}

export interface ComposedRoomMap {
  /** Our room id → Booking room code, only where it is unambiguous. */
  roomMap: Record<string, string>;
  /** Rooms whose rate plans disagree about which Booking room they map to. Left
   *  out of roomMap: a wrong mapping quotes a wrong price at a guest. */
  conflicts: { roomId: string; codes: string[] }[];
  /** Mapped channel rate plans we couldn't attribute to one of our rooms. */
  unknownRatePlans: string[];
}

/** Builds the room-level mapping. Rate plans mapped to the same Booking room are
 *  expected and fine (a room usually has several rate plans on Booking); rate
 *  plans of ONE room pointing at DIFFERENT Booking rooms is a genuine conflict
 *  and is reported instead of resolved by picking a winner. */
export function composeRoomMap(channelRates: ChannelRatePlan[], pairs: RoomRatePair[]): ComposedRoomMap {
  const roomByRate = new Map<string, string>();
  for (const p of pairs) if (p.rateId && p.roomId) roomByRate.set(p.rateId, p.roomId);

  const codesByRoom = new Map<string, Set<string>>();
  // A channel lists one entry per rate plan PER OCCUPANCY, so the same rate plan
  // id appears several times; report each unknown one once.
  const unknown = new Set<string>();
  for (const cr of channelRates) {
    const code = (cr.roomTypeCode ?? "").trim();
    if (!code) continue;
    const roomId = roomByRate.get(cr.ratePlanId);
    if (!roomId) {
      unknown.add(cr.ratePlanId);
      continue;
    }
    const set = codesByRoom.get(roomId) ?? new Set<string>();
    set.add(code);
    codesByRoom.set(roomId, set);
  }

  const roomMap: Record<string, string> = {};
  const conflicts: { roomId: string; codes: string[] }[] = [];
  for (const [roomId, codes] of codesByRoom) {
    if (codes.size === 1) roomMap[roomId] = [...codes][0];
    else conflicts.push({ roomId, codes: [...codes].sort() });
  }
  return { roomMap, conflicts, unknownRatePlans: [...unknown] };
}

/** Keeps only mappings whose Booking code we have actually captured a room for.
 *  A code we've never seen can't be compared against anything, and silently
 *  keeping it would look like a working mapping that never shows a badge. */
export function keepKnownCodes(
  roomMap: Record<string, string>,
  knownCodes: string[],
): { kept: Record<string, string>; dropped: { roomId: string; code: string }[] } {
  const known = new Set(knownCodes);
  const kept: Record<string, string> = {};
  const dropped: { roomId: string; code: string }[] = [];
  for (const [roomId, code] of Object.entries(roomMap)) {
    if (known.has(code)) kept[roomId] = code;
    else dropped.push({ roomId, code });
  }
  return { kept, dropped };
}
