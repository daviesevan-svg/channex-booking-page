// Admin write paths: inventory-grid saves, bulk updates, booking-driven
// availability adjustments, and retention (the cron prune).
import { db } from "../d1.server";
import type { AriActor } from "./log.server";
import { getInventoryOn } from "./read.server";
import { ensureSchema, type RestrictionCell } from "./schema.server";
import { withAriLog } from "./write.server";

/** Retention: drop ARI rows outside the useful window — anything before today
 *  (past dates are dead weight; a stay can't start in the past) and anything
 *  more than `futureDays` ahead (we never sell that far out). Keeps the D1
 *  tables bounded regardless of how far ahead Channex pushes. `catalog` isn't
 *  date-keyed, so it's left alone. The audit log is trimmed by when the change
 *  was recorded (`logDays` back), NOT by affected date — a dispute is about
 *  past dates, so that history must survive the availability/rate cleanup.
 *
 *  `logDays` is 30. It was 365, which sounds prudent until you price it: the log
 *  took 584k rows in its first 27 days — nearly twice the size of ALL the live
 *  ARI it describes — so a year of retention was on course for several GB against
 *  a 10 GB database. Channex pushes are ~99.9% of that volume, and their value
 *  decays fast: the question a change log answers is "what changed this week",
 *  not "what changed last spring". Nothing migrates — the existing backlog is 27
 *  days old, so it simply ages out over the next month.
 *  Runs on the cron; returns rows deleted. */
export async function pruneAri(
  futureDays = 730,
  logDays = 30,
): Promise<{ availability: number; rate: number; restriction: number; log: number }> {
  await ensureSchema();
  const D = db();
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + futureDays * 86_400_000).toISOString().slice(0, 10);
  // Table names are fixed literals (never user input), so interpolation is safe.
  const tables = ["availability", "rate", "restriction"] as const;
  const out = { availability: 0, rate: 0, restriction: 0, log: 0 };
  for (const t of tables) {
    const res = await D.prepare(`DELETE FROM ${t} WHERE date < ? OR date > ?`)
      .bind(today, horizon)
      .run();
    out[t] = res.meta?.changes ?? 0;
  }
  const logCutoff = Date.now() - logDays * 86_400_000;
  const logRes = await D.prepare(`DELETE FROM ari_log WHERE ts < ?`).bind(logCutoff).run();
  out.log = logRes.meta?.changes ?? 0;
  return out;
}

export interface InventoryEdits {
  currency: string;
  availability: { roomId: string; date: string; avail: number }[];
  /** `occupancy` omitted (or 0) is the occupancy-less price — one price for the
   *  date, which per-person pricing reads as a price PER ADULT. A value >= 1
   *  prices that exact number of adults, the same shape Channex pushes for a
   *  per-person plan. */
  prices: { rateId: string; roomId: string; date: string; price: number; occupancy?: number }[];
  /** Per-occupancy prices to REMOVE, so the date inherits again (a nearby
   *  occupancy, else the occupancy-less price × adults). Clearing the cell is
   *  the only way to undo an override, so blank has to mean delete rather than
   *  "leave alone" the way it does for the other fields. */
  priceDeletes: { rateId: string; roomId: string; date: string; occupancy: number }[];
  restrictions: {
    rateId: string;
    roomId: string;
    date: string;
    stopSell: boolean;
    minStay: number;
    cta: boolean;
    ctd: boolean;
  }[];
}

/** Upsert manual ARI edits from the inventory grid. When `actor` is given, the
 *  change is diffed against the current values and written to the audit log. */
export async function saveInventory(hotelCode: string, edits: InventoryEdits, actor?: AriActor): Promise<void> {
  await ensureSchema();
  const D = db();
  const availStmt = D.prepare(
    `INSERT INTO availability (hotel_code,room_type_id,date,avail) VALUES (?,?,?,?)
     ON CONFLICT(hotel_code,room_type_id,date) DO UPDATE SET avail=excluded.avail`,
  );
  const rateStmt = D.prepare(
    `INSERT INTO rate (hotel_code,room_type_id,rate_plan_id,date,occupancy,price_minor,currency,fraction_size)
     VALUES (?,?,?,?,?,?,?,2)
     ON CONFLICT(hotel_code,room_type_id,rate_plan_id,date,occupancy)
     DO UPDATE SET price_minor=excluded.price_minor,currency=excluded.currency`,
  );
  const rateDelStmt = D.prepare(
    `DELETE FROM rate WHERE hotel_code=? AND room_type_id=? AND rate_plan_id=? AND date=? AND occupancy=?`,
  );
  const restrStmt = D.prepare(
    `INSERT INTO restriction (hotel_code,room_type_id,rate_plan_id,date,stop_sell,min_stay_arrival,closed_to_arrival,closed_to_departure)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(hotel_code,room_type_id,rate_plan_id,date)
     DO UPDATE SET stop_sell=excluded.stop_sell,min_stay_arrival=excluded.min_stay_arrival,closed_to_arrival=excluded.closed_to_arrival,closed_to_departure=excluded.closed_to_departure`,
  );

  const stmts: D1PreparedStatement[] = [];
  for (const a of edits.availability) stmts.push(availStmt.bind(hotelCode, a.roomId, a.date, a.avail));
  for (const p of edits.prices)
    stmts.push(
      rateStmt.bind(hotelCode, p.roomId, p.rateId, p.date, p.occupancy ?? 0, Math.round(p.price * 100), edits.currency),
    );
  for (const p of edits.priceDeletes)
    stmts.push(rateDelStmt.bind(hotelCode, p.roomId, p.rateId, p.date, p.occupancy));
  for (const r of edits.restrictions)
    stmts.push(
      restrStmt.bind(hotelCode, r.roomId, r.rateId, r.date, r.stopSell ? 1 : 0, r.minStay, r.cta ? 1 : 0, r.ctd ? 1 : 0),
    );

  const write = async () => {
    for (let i = 0; i < stmts.length; i += 100) await D.batch(stmts.slice(i, i + 100));
  };
  if (!actor) return write();
  const dates = [
    ...edits.availability.map((a) => a.date),
    ...edits.prices.map((p) => p.date),
    ...edits.priceDeletes.map((p) => p.date),
    ...edits.restrictions.map((r) => r.date),
  ];
  await withAriLog(hotelCode, actor, dates, write);
}

export interface BulkScope {
  currency: string;
  /** target dates (already filtered to the chosen days of week) */
  dates: string[];
  /** rooms in scope — availability is set per room */
  rooms: { id: string }[];
  /** rates in scope — price + restrictions are set per (room, rate) it's priced
   *  on. `channexRateIds` maps roomId → the room's real Channex rate id for
   *  consolidated imported rates; ARI rows are stored under that id (see
   *  rateChannexId in catalog.server.ts — not imported here, catalog already
   *  depends on the ari modules). */
  rates: { id: string; prices: Record<string, number>; channexRateIds?: Record<string, string> }[];
  /** each field is applied only when defined; undefined = leave untouched */
  avail?: number;
  price?: number;
  minStay?: number;
  stopSell?: boolean;
  cta?: boolean;
  ctd?: boolean;
}

/** Apply one set of values across a range of cells. Restriction fields that
 *  aren't being changed are read back and preserved, so e.g. a bulk stop-sell
 *  doesn't clear existing min-stay/CTA/CTD on the same cells. */
export async function applyBulkUpdate(hotelCode: string, s: BulkScope, actor?: AriActor): Promise<{ cells: number }> {
  if (!s.dates.length) return { cells: 0 };
  // Bulk sets the occupancy-less price only: the panel has one price box, and in
  // per-person mode that reads as a price per adult across the whole range.
  const edits: InventoryEdits = { currency: s.currency, availability: [], prices: [], priceDeletes: [], restrictions: [] };

  if (s.avail !== undefined) {
    const avail = Math.max(0, Math.round(s.avail));
    for (const room of s.rooms) for (const date of s.dates) edits.availability.push({ roomId: room.id, date, avail });
  }

  const touchRestr = s.minStay !== undefined || s.stopSell !== undefined || s.cta !== undefined || s.ctd !== undefined;
  const touchPrice = s.price !== undefined && s.price > 0;
  if (touchPrice || touchRestr) {
    // Read the current values once so we can preserve restriction fields the
    // operator left blank. Only the chosen dates: a bulk edit is already
    // filtered to days of the week, so "every Saturday next year" is 52 dates
    // spread over 365 — reading the span would be seven times the rows for the
    // same answer. Lookups are by exact `room|rate|date` key, so this changes
    // nothing about the result.
    const existing = touchRestr
      ? await getInventoryOn(hotelCode, s.dates)
      : { availability: {}, prices: {}, pricesByOcc: {}, restrictions: {} as Record<string, RestrictionCell> };
    for (const rate of s.rates) {
      for (const room of s.rooms) {
        if (rate.prices[room.id] === undefined) continue; // rate not offered on this room
        // Store under the room's real Channex rate id so guest pricing (which
        // reads by that id) sees the edit; equals rate.id for native rates.
        const rid = rate.channexRateIds?.[room.id] ?? rate.id;
        for (const date of s.dates) {
          if (touchPrice) edits.prices.push({ roomId: room.id, rateId: rid, date, price: s.price! });
          if (touchRestr) {
            const cur = existing.restrictions[`${room.id}|${rid}|${date}`];
            edits.restrictions.push({
              roomId: room.id,
              rateId: rid,
              date,
              stopSell: s.stopSell ?? cur?.stopSell ?? false,
              minStay: s.minStay ?? cur?.minStay ?? 0,
              cta: s.cta ?? cur?.cta ?? false,
              ctd: s.ctd ?? cur?.ctd ?? false,
            });
          }
        }
      }
    }
  }

  await saveInventory(hotelCode, edits, actor);
  return { cells: edits.availability.length + edits.prices.length + edits.restrictions.length };
}

/** Adjust availability by `delta` per (room, date), clamped at 0. Only affects
 *  rooms/dates that already have an availability row (a room with no row is not
 *  bookable, so it never reaches this path). */
async function adjustAvailability(
  hotelCode: string,
  items: { roomId: string; date: string; by: number }[],
  delta: 1 | -1,
): Promise<void> {
  if (!items.length) return;
  await ensureSchema();
  const D = db();
  const stmt = D.prepare(
    `UPDATE availability SET avail = MAX(0, avail + ?) WHERE hotel_code=? AND room_type_id=? AND date=?`,
  );
  const stmts = items.map((i) => stmt.bind(delta * i.by, hotelCode, i.roomId, i.date));
  for (let i = 0; i < stmts.length; i += 100) await D.batch(stmts.slice(i, i + 100));
}

/** Reduce availability when a booking is made. */
export const decrementAvailability = (
  hotelCode: string,
  items: { roomId: string; date: string; by: number }[],
) => adjustAvailability(hotelCode, items, -1);

/** Restore availability when a booking is cancelled. */
export const incrementAvailability = (
  hotelCode: string,
  items: { roomId: string; date: string; by: number }[],
) => adjustAvailability(hotelCode, items, 1);

/** True if any requested (room, date) has fewer rooms left than needed, per our
 *  cached ARI. A best-effort guard against booking a room that sold between
 *  checkout and payment completion — Channex remains the authoritative gate. */
export async function availabilityShortfall(
  hotelCode: string,
  items: { roomId: string; date: string; by: number }[],
): Promise<boolean> {
  if (!items.length) return false;
  await ensureSchema();
  const D = db();
  const stmt = D.prepare(`SELECT avail FROM availability WHERE hotel_code=? AND room_type_id=? AND date=?`);
  for (const i of items) {
    const row = await stmt.bind(hotelCode, i.roomId, i.date).first<{ avail: number }>();
    if ((row?.avail ?? 0) < i.by) return true;
  }
  return false;
}
