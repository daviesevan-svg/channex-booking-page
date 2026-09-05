// Guest/read paths: the ARI slices read at search time (and by the admin grid
// and the write paths' before/after snapshots).
import { chunkForBinds, placeholders } from "../d1-limits";
import { db } from "../d1.server";
import { fromMinor } from "./fraction";
import { ensureSchema, type InventoryData } from "./schema.server";

/** Read the ARI for a [from, to] inclusive window, as lookup maps.
 *
 *  `roomId` narrows the read to one room type. The room page's calendar asks
 *  "when is THIS room free?" and used to read every room's rows for the whole
 *  window and discard all but one in JavaScript — on a 20-room property that is
 *  95% of the rows fetched to be thrown away. */
export async function getInventory(hotelCode: string, from: string, to: string, roomId?: string): Promise<InventoryData> {
  return readInventory(hotelCode, [
    roomId
      ? { where: "date>=? AND date<=? AND room_type_id=?", binds: [from, to, roomId] }
      : { where: "date>=? AND date<=?", binds: [from, to] },
  ]);
}

/** Read the ARI for exactly these dates — the sparse counterpart to getInventory.
 *
 *  What it does NOT read is the point. A push carrying two dates two years apart
 *  was snapshotted as the whole span between them, which meant every unrelated
 *  cell in those two years was compared, and anything another writer changed in
 *  the meantime was logged as this push's doing. Reading only the dates a write
 *  actually touches removes both the cost and the misattribution.
 *
 *  Duplicates are collapsed and the order is irrelevant — callers pass raw
 *  per-notification date lists. */
export async function getInventoryOn(hotelCode: string, dates: Iterable<string>): Promise<InventoryData> {
  const uniq = [...new Set(dates)].sort();
  if (uniq.length === 0) return { availability: {}, prices: {}, pricesByOcc: {}, restrictions: {} };

  // Chunked because D1 allows only 100 bound parameters per query, hotel_code
  // taking one of them — NOT SQLite's ~999, which an earlier guard at 500 dates
  // was written against. That guard never tripped, so a push touching 100 or
  // more dates failed outright with "too many SQL variables at offset 281"
  // (offset 281 being exactly the 100th date placeholder). A year of dates in
  // one notification is ordinary, so this was a live push failure, not a corner.
  //
  // Chunks are disjoint by date and every key in InventoryData contains the
  // date, so nothing can collide when their rows are folded together.
  //
  // All the chunks go to D1 in ONE batch. The parameter cap is per STATEMENT,
  // not per batch — the insert path has always sent 100 statements of 11
  // parameters in a batch — so chunking costs statements, not round trips. The
  // first version of this awaited each chunk in turn, which turned a 730-day
  // push into 8 sequential round trips for the before snapshot and 8 more for
  // the after, and that showed up as pushes being visibly slow to process.
  return readInventory(
    hotelCode,
    chunkForBinds(uniq, 1).map((chunk) => ({ where: `date IN (${placeholders(chunk.length)})`, binds: chunk })),
  );
}

/** One date predicate and its bound values. Each `where` is built from fixed
 *  literals and placeholders only — never from caller text. */
interface DatePart {
  where: string;
  binds: string[];
}

type AvailRow = { room_type_id: string; date: string; avail: number };
type RateRow = { room_type_id: string; rate_plan_id: string; date: string; occupancy: number; price_minor: number; fraction_size: number };
type RestrRow = {
  room_type_id: string;
  rate_plan_id: string;
  date: string;
  stop_sell: number;
  min_stay_arrival: number;
  closed_to_arrival: number;
  closed_to_departure: number;
};

/** Shared body of the two readers above. Every part's three table reads go in a
 *  single `batch()`, so the cost is one round trip regardless of how many parts
 *  the date list had to be split into. */
async function readInventory(hotelCode: string, parts: DatePart[]): Promise<InventoryData> {
  await ensureSchema();
  const D = db();
  if (parts.length === 0) return { availability: {}, prices: {}, pricesByOcc: {}, restrictions: {} };

  const stmts = parts.flatMap((p) => [
    D.prepare(`SELECT room_type_id, date, avail FROM availability WHERE hotel_code=? AND ${p.where}`).bind(hotelCode, ...p.binds),
    D.prepare(`SELECT room_type_id, rate_plan_id, date, occupancy, price_minor, fraction_size FROM rate WHERE hotel_code=? AND ${p.where}`).bind(
      hotelCode,
      ...p.binds,
    ),
    D.prepare(
      `SELECT room_type_id, rate_plan_id, date, stop_sell, min_stay_arrival, closed_to_arrival, closed_to_departure
       FROM restriction WHERE hotel_code=? AND ${p.where}`,
    ).bind(hotelCode, ...p.binds),
  ]);

  const res = await D.batch(stmts);

  // Results come back in the order the statements went out: three per part.
  const av: AvailRow[] = [];
  const rt: RateRow[] = [];
  const rs: RestrRow[] = [];
  for (let i = 0; i < res.length; i += 3) {
    av.push(...((res[i]?.results ?? []) as AvailRow[]));
    rt.push(...((res[i + 1]?.results ?? []) as RateRow[]));
    rs.push(...((res[i + 2]?.results ?? []) as RestrRow[]));
  }

  const data: InventoryData = { availability: {}, prices: {}, pricesByOcc: {}, restrictions: {} };
  for (const r of av) data.availability[`${r.room_type_id}|${r.date}`] = r.avail;
  // A rate may have several occupancy rows: Channex prices a party size
  // (occupancy>=1), a manual grid or bulk edit writes the occupancy-less row 0.
  // The CHANNEL WINS — take the highest occupancy>=1, and fall back to row 0
  // only when the channel has never priced this cell.
  //
  // It used to be the other way round (occupancy 0 preferred unconditionally),
  // which made a manual price permanent: one bulk edit pinned those cells and
  // every later Channex push was stored, counted and then ignored on read, so a
  // rate plan silently showed a stale price forever while its neighbour tracked
  // the channel. Channex is the source of truth for a connected property.
  //
  // Folding every part through one map is the same answer as folding each
  // separately, because the key carries the date and the parts are disjoint by
  // date — two parts can never offer a price for the same key.
  const priceOcc: Record<string, number> = {};
  for (const r of rt) {
    const key = `${r.room_type_id}|${r.rate_plan_id}|${r.date}`;
    const price = fromMinor(r.price_minor, r.fraction_size);
    // Every row also lands in the per-occupancy map (per-person rates price each
    // party size from its own row rather than the collapsed value below).
    (data.pricesByOcc[key] ??= {})[r.occupancy] = price;
    const prevOcc = priceOcc[key];
    // Order-independent: whichever row arrives first, the highest occupancy>=1
    // ends up winning, and 0 only survives if nothing else priced the cell.
    if (prevOcc === undefined || (r.occupancy > 0 && (prevOcc === 0 || r.occupancy > prevOcc))) {
      data.prices[key] = price;
      priceOcc[key] = r.occupancy;
    }
  }
  for (const r of rs)
    data.restrictions[`${r.room_type_id}|${r.rate_plan_id}|${r.date}`] = {
      stopSell: Boolean(r.stop_sell),
      minStay: r.min_stay_arrival || 0,
      cta: Boolean(r.closed_to_arrival),
      ctd: Boolean(r.closed_to_departure),
    };
  return data;
}
