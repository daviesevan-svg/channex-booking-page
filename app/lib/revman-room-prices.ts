// Room-level prices from a Booking.com hotel page. Pure, so the parse can be
// tested against saved HTML without touching the network.
//
// The hotel page we already fetch for comp pricing embeds its whole availability
// table as JSON under `b_rooms_available_and_soldout`: every room type (id +
// name) and, inside each, every bookable "block" — Booking's term for one rate
// plan on that room, carrying its price, meal plan, cancellation type and, most
// usefully, `b_stay_prices`: the total for stays of 1..N nights starting that
// date. So one scrape we've ALREADY paid for yields per-room, per-rate-plan,
// per-length-of-stay prices. Verified against 4 hotels (4, 7, 14 and 17 room
// types) in July 2026.
//
// A hotel can expose a lot of blocks (17 rooms × 9 rate plans at one chain
// hotel), and storing every one per date would be thousands of rows a day for
// no decision-making gain. Each room is therefore reduced to the two blocks a
// comparison actually needs: the cheapest, and the cheapest fully refundable
// one. Comparing a flexible rate to someone's non-refundable rate is the classic
// way to draw a false conclusion, so both sides are kept.

/** Total price for a stay of `nights` nights starting on the captured date. */
export interface OtaStayPrice {
  nights: number;
  totalMinor: number;
}

/** One rate plan on one room type, as Booking presents it to a public visitor. */
export interface OtaBlock {
  /** Booking's block id, e.g. "26707_92051996_0_41_0". */
  blockRef: string;
  /** Rate-plan segment of the block id — stable across dates. */
  ratePlanRef: string;
  /** Total for the stay as searched (one night, the way capture searches). */
  priceMinor: number;
  /** e.g. "breakfast"; null when the rate is room-only. */
  mealPlan: string | null;
  /** True for free_cancellation. Non-refundable rates are cheaper and must not
   *  be compared against a flexible direct rate. */
  refundable: boolean;
  /** Booking showed a Genius (loyalty) price to an anonymous visitor. */
  genius: boolean;
  maxPersons: number;
  /** Booking says the price includes taxes and charges. When false, the price is
   *  not comparable to an all-in direct price without adding the extras. */
  allIncluded: boolean;
  /** Totals for longer stays starting the same date, ascending. Length varies by
   *  min/max-stay restrictions, so a night count can simply be absent. */
  stays: OtaStayPrice[];
}

/** One room type on the page, reduced to the blocks worth storing. */
export interface OtaRoom {
  /** Booking's room-type id — stable, and what a channel manager maps to. */
  roomRef: string;
  name: string;
  maxPersons: number;
  currency: string;
  /** How many blocks the page offered before reduction (context, not a price). */
  blocksSeen: number;
  cheapest: OtaBlock;
  /** Cheapest freely-cancellable block; null when the room has none. */
  cheapestFlexible: OtaBlock | null;
}

/** True when the HTML really is a Booking hotel page. An anti-bot challenge or a
 *  JS-less shell is a few KB with none of this, and must NOT be read as "this
 *  hotel had no availability". */
export function isBookingHotelPage(html: string): boolean {
  return html.includes("hp_hotel_name") || html.includes("b_hotel_id");
}

/** True when the availability section is present. On the no-render fetch it is
 *  always server-rendered, so its absence means we got a partial page rather
 *  than a genuinely sold-out date. */
export function hasRoomTable(html: string): boolean {
  return html.includes("b_rooms_available_and_soldout") || html.includes("hprt-table");
}

/** Extracts the balanced JSON array that follows `key` in the page. Booking
 *  embeds it in a script as a plain array literal, so brace matching is enough —
 *  and safer than a regex against 2 MB of HTML. */
function extractArray(html: string, key: string): unknown[] | null {
  const at = html.indexOf(key);
  if (at < 0) return null;
  const open = html.indexOf("[", at);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      try {
        const parsed = JSON.parse(html.slice(open, i + 1));
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  "US$": "USD", "A$": "AUD", "C$": "CAD", "R$": "BRL", "£": "GBP", "€": "EUR", "$": "USD",
};

/** ISO currency of a Booking price string like "£104" / "US$140". */
function currencyOf(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/US\$|A\$|C\$|R\$|£|€|\$/);
  return m ? (CURRENCY_BY_SYMBOL[m[0]] ?? null) : null;
}

/** Amount of a Booking price string in minor units ("£1,180" → 118000). */
function amountMinor(text: string | undefined): number | null {
  if (!text) return null;
  const n = parseFloat(text.replace(/[^\d.,]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

const decode = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").trim();

/** Price of a block in minor units. `b_raw_price` carries the pennies that
 *  `b_price` rounds away, so it is preferred — but only when the two agree to
 *  within a unit, which guards against the raw field being quoted in a different
 *  currency than the one we asked for. */
function blockPriceMinor(raw: unknown, display: string | undefined): number | null {
  const shown = amountMinor(display);
  const exact = typeof raw === "string" || typeof raw === "number" ? Math.round(Number(raw) * 100) : null;
  if (exact === null || !Number.isFinite(exact) || exact <= 0) return shown;
  if (shown === null) return exact;
  return Math.abs(exact - shown) <= 100 ? exact : shown;
}

interface RawBlock {
  b_block_id?: string;
  b_price?: string;
  b_raw_price?: string | number;
  b_max_persons?: number;
  b_mealplan_included_name?: string | null;
  b_cancellation_type?: string;
  b_rate_is_genius?: number;
  b_stay_prices?: { b_stays?: number; b_raw_price?: string | number; b_price?: string }[];
  b_price_breakdown_simplified?: { b_charges_info_copy?: { b_is_all_included?: number } };
}

interface RawRoom {
  b_id?: number | string;
  b_name?: string;
  b_blocks?: RawBlock[];
}

function toBlock(raw: RawBlock, roomRef: string): OtaBlock | null {
  const blockRef = typeof raw.b_block_id === "string" ? raw.b_block_id : "";
  const priceMinor = blockPriceMinor(raw.b_raw_price, raw.b_price);
  if (!blockRef || priceMinor === null) return null;
  // "{roomId}_{ratePlanId}_{...}" — the rate plan is the second segment.
  const parts = blockRef.split("_");
  const stays: OtaStayPrice[] = [];
  for (const s of raw.b_stay_prices ?? []) {
    const nights = Number(s?.b_stays);
    const totalMinor = blockPriceMinor(s?.b_raw_price, s?.b_price);
    if (Number.isFinite(nights) && nights >= 1 && totalMinor !== null) stays.push({ nights, totalMinor });
  }
  stays.sort((a, b) => a.nights - b.nights);
  return {
    blockRef,
    ratePlanRef: parts[1] ?? "",
    priceMinor,
    mealPlan: raw.b_mealplan_included_name ? decode(String(raw.b_mealplan_included_name)) : null,
    refundable: raw.b_cancellation_type === "free_cancellation",
    genius: raw.b_rate_is_genius === 1,
    maxPersons: Number.isFinite(Number(raw.b_max_persons)) ? Number(raw.b_max_persons) : 0,
    allIncluded: raw.b_price_breakdown_simplified?.b_charges_info_copy?.b_is_all_included === 1,
    stays: stays.length ? stays : [{ nights: 1, totalMinor: priceMinor }],
  };
}

/** Parses every bookable room type out of a Booking hotel page. Rooms with no
 *  bookable block (sold out for the searched night) are omitted — an empty
 *  result on a page that HAS a room table means the hotel is unavailable. */
export function parseHotelRoomPrices(html: string): OtaRoom[] {
  const raw = extractArray(html, "b_rooms_available_and_soldout") as RawRoom[] | null;
  if (!raw) return [];
  const rooms: OtaRoom[] = [];
  for (const r of raw) {
    const roomRef = r?.b_id === undefined || r?.b_id === null ? "" : String(r.b_id);
    if (!roomRef) continue;
    const blocks: OtaBlock[] = [];
    for (const b of r.b_blocks ?? []) {
      const block = toBlock(b, roomRef);
      if (block) blocks.push(block);
    }
    if (blocks.length === 0) continue;
    const byPrice = [...blocks].sort((a, b) => a.priceMinor - b.priceMinor);
    const cheapest = byPrice[0];
    const currency =
      currencyOf(r.b_blocks?.find((b) => b.b_block_id === cheapest.blockRef)?.b_price) ??
      currencyOf(r.b_blocks?.[0]?.b_price) ??
      "GBP";
    rooms.push({
      roomRef,
      name: r.b_name ? decode(String(r.b_name)) : roomRef,
      maxPersons: Math.max(...blocks.map((b) => b.maxPersons), 0),
      currency,
      blocksSeen: blocks.length,
      cheapest,
      cheapestFlexible: byPrice.find((b) => b.refundable) ?? null,
    });
  }
  return rooms;
}

/** Cheapest bookable price across all room types — the same headline figure the
 *  comp table already stores, but taken from the structured data so it keeps its
 *  pennies instead of Booking's rounded display string. */
export function cheapestRoomPrice(rooms: OtaRoom[]): { minor: number; currency: string } | null {
  let best: { minor: number; currency: string } | null = null;
  for (const r of rooms) {
    if (!best || r.cheapest.priceMinor < best.minor) best = { minor: r.cheapest.priceMinor, currency: r.currency };
  }
  return best;
}

/** Booking's total for a stay of `nights` nights on this block, or null when
 *  Booking didn't offer that length (min/max stay). Never multiplies the
 *  one-night price out: a length Booking won't sell is not a price we can quote. */
export function stayTotalMinor(block: Pick<OtaBlock, "stays">, nights: number): number | null {
  return block.stays.find((s) => s.nights === nights)?.totalMinor ?? null;
}
