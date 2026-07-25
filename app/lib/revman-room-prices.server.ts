// Storage for the room-level prices each comp capture parses out of a Booking
// hotel page (see revman-room-prices for the parse and why each room is reduced
// to two blocks).
//
// One row per (hotel, date, room type), holding the cheapest block and the
// cheapest freely-cancellable one. Each capture REPLACES that hotel-date's rows,
// so a room type the hotel has withdrawn disappears instead of lingering as a
// stale price. There is deliberately no history table here: the headline comp
// price already keeps one (rev_comp_price_hist), and room-level history would
// multiply that by ~15 rows per hotel-day for a signal nothing reads yet.
import { getDB } from "./config.server";
import type { OtaBlock, OtaRoom, OtaStayPrice } from "./revman-room-prices";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db().batch([
    db().prepare(
      `CREATE TABLE IF NOT EXISTS rev_ota_room_price (
        pid TEXT NOT NULL,
        comp_id TEXT NOT NULL,
        date TEXT NOT NULL,
        room_ref TEXT NOT NULL,
        room_name TEXT NOT NULL,
        max_persons INTEGER,
        currency TEXT,
        blocks_seen INTEGER,
        price_minor INTEGER NOT NULL,
        meal_plan TEXT,
        genius INTEGER NOT NULL DEFAULT 0,
        all_included INTEGER NOT NULL DEFAULT 0,
        stays_json TEXT,
        flex_price_minor INTEGER,
        flex_meal_plan TEXT,
        flex_stays_json TEXT,
        captured_at TEXT NOT NULL,
        PRIMARY KEY (pid, comp_id, date, room_ref)
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS rev_ota_room_price_pid_date ON rev_ota_room_price (pid, date)`),
  ]);
  schemaReady = true;
}

/** A room type's prices as captured from an OTA page. */
export interface RoomPriceRow {
  compId: string;
  date: string;
  roomRef: string;
  roomName: string;
  maxPersons: number | null;
  currency: string | null;
  blocksSeen: number | null;
  /** Cheapest block, whatever its conditions. */
  priceMinor: number;
  mealPlan: string | null;
  genius: boolean;
  allIncluded: boolean;
  stays: OtaStayPrice[];
  /** Cheapest freely-cancellable block; null when the room had none. */
  flexPriceMinor: number | null;
  flexMealPlan: string | null;
  flexStays: OtaStayPrice[];
  capturedAt: string;
}

const staysJson = (stays: OtaStayPrice[]): string => JSON.stringify(stays.map((s) => [s.nights, s.totalMinor]));

function parseStays(raw: string | null): OtaStayPrice[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as [number, number][];
    return Array.isArray(arr)
      ? arr
          .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
          .map(([nights, totalMinor]) => ({ nights, totalMinor }))
      : [];
  } catch {
    return [];
  }
}

/** Replaces the stored room prices for one hotel-date. Called from capture, in
 *  the same pass that stores the headline price. */
export async function writeRoomPrices(
  pid: string,
  compId: string,
  date: string,
  rooms: OtaRoom[],
  capturedAt: string,
): Promise<void> {
  await ensureSchema();
  const stmts: D1PreparedStatement[] = [
    db().prepare(`DELETE FROM rev_ota_room_price WHERE pid = ? AND comp_id = ? AND date = ?`).bind(pid, compId, date),
  ];
  const insert = db().prepare(
    `INSERT INTO rev_ota_room_price
       (pid, comp_id, date, room_ref, room_name, max_persons, currency, blocks_seen,
        price_minor, meal_plan, genius, all_included, stays_json,
        flex_price_minor, flex_meal_plan, flex_stays_json, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rooms) {
    const flex: OtaBlock | null = r.cheapestFlexible;
    stmts.push(
      insert.bind(
        pid, compId, date, r.roomRef, r.name, r.maxPersons, r.currency, r.blocksSeen,
        r.cheapest.priceMinor, r.cheapest.mealPlan, r.cheapest.genius ? 1 : 0,
        r.cheapest.allIncluded ? 1 : 0, staysJson(r.cheapest.stays),
        flex?.priceMinor ?? null, flex?.mealPlan ?? null, flex ? staysJson(flex.stays) : null,
        capturedAt,
      ),
    );
  }
  // Chained rather than one batch: a chain hotel can list 17 room types, and the
  // DELETE must land before its INSERTs regardless of how they chunk.
  for (let i = 0; i < stmts.length; i += 50) await db().batch(stmts.slice(i, i + 50));
}

interface RoomPriceDbRow {
  compId: string;
  date: string;
  roomRef: string;
  roomName: string;
  maxPersons: number | null;
  currency: string | null;
  blocksSeen: number | null;
  priceMinor: number;
  mealPlan: string | null;
  genius: number;
  allIncluded: number;
  staysJson: string | null;
  flexPriceMinor: number | null;
  flexMealPlan: string | null;
  flexStaysJson: string | null;
  capturedAt: string;
}

const toRow = (r: RoomPriceDbRow): RoomPriceRow => ({
  compId: r.compId,
  date: r.date,
  roomRef: r.roomRef,
  roomName: r.roomName,
  maxPersons: r.maxPersons,
  currency: r.currency,
  blocksSeen: r.blocksSeen,
  priceMinor: r.priceMinor,
  mealPlan: r.mealPlan,
  genius: r.genius === 1,
  allIncluded: r.allIncluded === 1,
  stays: parseStays(r.staysJson),
  flexPriceMinor: r.flexPriceMinor,
  flexMealPlan: r.flexMealPlan,
  flexStays: parseStays(r.flexStaysJson),
  capturedAt: r.capturedAt,
});

const SELECT = `SELECT comp_id AS compId, date, room_ref AS roomRef, room_name AS roomName,
    max_persons AS maxPersons, currency, blocks_seen AS blocksSeen, price_minor AS priceMinor,
    meal_plan AS mealPlan, genius, all_included AS allIncluded, stays_json AS staysJson,
    flex_price_minor AS flexPriceMinor, flex_meal_plan AS flexMealPlan, flex_stays_json AS flexStaysJson,
    captured_at AS capturedAt
  FROM rev_ota_room_price`;

/** Room prices for one hotel of the set over a date range. */
export async function getRoomPrices(pid: string, compId: string, from: string, to: string): Promise<RoomPriceRow[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(`${SELECT} WHERE pid = ? AND comp_id = ? AND date >= ? AND date <= ? ORDER BY date, price_minor`)
    .bind(pid, compId, from, to)
    .all<RoomPriceDbRow>();
  return (results ?? []).map(toRow);
}

/** Room prices for every hotel of the set on one date. */
export async function getRoomPricesForDate(pid: string, date: string): Promise<RoomPriceRow[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(`${SELECT} WHERE pid = ? AND date = ? ORDER BY comp_id, price_minor`)
    .bind(pid, date)
    .all<RoomPriceDbRow>();
  return (results ?? []).map(toRow);
}

/** Removes room prices for dates now in the past — they can't inform a decision
 *  and the table is rewritten in place rather than kept as history. */
export async function pruneRoomPrices(beforeDate: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`DELETE FROM rev_ota_room_price WHERE date < ?`).bind(beforeDate).run();
}
