// Shared ARI write primitives, used by BOTH Channex ingest (ingest.server.ts)
// and admin edits (admin.server.ts): the multi-row upsert builders, the audit
// diff, and the log-write wrappers. One copy on purpose — the partial-
// restriction sentinel contract (RESTR_ENSURE before RESTR_UPSERT, -1 means
// "unchanged") must not fork.
import { chunkRows, valuesTuples } from "../d1-limits";
import { db } from "../d1.server";
import type { AriActor, AriLogEntry } from "./log.server";
import { getInventoryOn } from "./read.server";
import type { InventoryData } from "./schema.server";

/** Diff two inventory snapshots into per-value change entries. Compares at the
 *  "displayed value" granularity (what getInventory in read.server.ts exposes),
 *  so it's identical for user grid edits and Channex pushes and free of
 *  per-occupancy noise. */
export function diffInventory(
  before: InventoryData,
  after: InventoryData,
  /** Dates the write actually touched. A change on any other date belongs to
   *  someone else — a concurrent push, or a date that merely fell between two
   *  this write happened to span — and must not be attributed to this actor.
   *  Omit to diff everything the snapshots contain. */
  onlyDates?: ReadonlySet<string>,
): AriLogEntry[] {
  const entries: AriLogEntry[] = [];

  const availKeys = new Set([...Object.keys(before.availability), ...Object.keys(after.availability)]);
  for (const k of availKeys) {
    const o = before.availability[k];
    const n = after.availability[k];
    if (o === n) continue;
    const [roomTypeId, date] = k.split("|");
    if (onlyDates && !onlyDates.has(date)) continue;
    entries.push({ kind: "availability", roomTypeId, ratePlanId: null, date, field: "avail", oldValue: o?.toString() ?? null, newValue: n?.toString() ?? null });
  }

  const priceKeys = new Set([...Object.keys(before.prices), ...Object.keys(after.prices)]);
  for (const k of priceKeys) {
    const o = before.prices[k];
    const n = after.prices[k];
    if (o === n) continue;
    const [roomTypeId, ratePlanId, date] = k.split("|");
    if (onlyDates && !onlyDates.has(date)) continue;
    entries.push({ kind: "price", roomTypeId, ratePlanId, date, field: "price", oldValue: o?.toString() ?? null, newValue: n?.toString() ?? null });
  }

  // Restrictions — stop_sell, min_stay, cta, ctd — are deliberately NOT logged,
  // for two reasons.
  //
  // They could not be measured honestly here. A restriction row that doesn't
  // exist yet is indistinguishable from one set to its default, so simply
  // CREATING a row registered as a change. The asymmetry that produced is not
  // subtle: stop_sell went false→true 162,034 times against true→false 31,395,
  // and min_stay went 0→1 136,643 times against 1→0 just 14,162. Fields that
  // switch on ten times for every time they switch off are describing our write
  // pattern, not the hotel's decisions. Together they were 73% of a log that had
  // reached 584k rows — nearly twice the size of all the live ARI it described.
  //
  // And they need not be. Channex keeps three months of full logs of everything
  // it sent, and it is the source of 99.9% of these rows, so it is already the
  // system of record for them. This log answers a narrower, more immediate
  // question — what moved recently — and for that, availability and price are
  // the answer. The inventory grid still shows every current restriction value;
  // only the change history stops carrying them.
  return entries;
}

// ---- Multi-row writes ----------------------------------------------------
//
// Every ARI write is many rows of the same shape, which used to mean one bound
// statement per row: a 730-day availability push issued 730 statements, batched
// 100 at a time, so 8 sequential round trips just to store one number per day.
//
// The rows go in one statement each instead, as many as the 100-parameter cap
// allows — 25 for availability at 4 parameters a row, 12 for rate, 10 for
// restriction, 9 for the log. Same rows in the same order, so an upsert that
// repeats a key still resolves last-wins exactly as the statement sequence did
// (measured, see valuesTuples).

export interface RowWrite {
  /** Parameters per row — sets how many rows fit one statement. */
  cols: number;
  /** Full SQL, given the `(?,?),(?,?)` fragment. */
  sql: (values: string) => string;
}

export const AVAIL_UPSERT: RowWrite = {
  cols: 4,
  sql: (v) => `INSERT INTO availability (hotel_code,room_type_id,date,avail) VALUES ${v}
     ON CONFLICT(hotel_code,room_type_id,date) DO UPDATE SET avail=excluded.avail`,
};

export const RATE_UPSERT: RowWrite = {
  cols: 8,
  sql: (v) => `INSERT INTO rate (hotel_code,room_type_id,rate_plan_id,date,occupancy,price_minor,currency,fraction_size)
     VALUES ${v}
     ON CONFLICT(hotel_code,room_type_id,rate_plan_id,date,occupancy)
     DO UPDATE SET price_minor=excluded.price_minor,currency=excluded.currency,fraction_size=excluded.fraction_size`,
};

// Channex splits one logical update into several restriction_changes: rates
// arrive in one change and min_stay/stop_sell in another, often for the same
// cell. Each change therefore carries only SOME fields, and a field that is
// absent means "unchanged" — not zero. Absent fields are bound as -1 and the
// upsert's CASE keeps the stored value. (NULL can't be the sentinel: SQLite
// enforces NOT NULL on the proposed row BEFORE upsert conflict resolution.)
// RESTR_ENSURE must run first so the insert arm — which would store the -1s —
// is never taken.
export const RESTR_ENSURE: RowWrite = {
  cols: 4,
  sql: (v) => `INSERT OR IGNORE INTO restriction (hotel_code,room_type_id,rate_plan_id,date) VALUES ${v}`,
};

const keepAbsent = (col: string) => `${col}=CASE WHEN excluded.${col}<0 THEN ${col} ELSE excluded.${col} END`;

export const RESTR_UPSERT: RowWrite = {
  cols: 10,
  sql: (v) => `INSERT INTO restriction (hotel_code,room_type_id,rate_plan_id,date,stop_sell,closed_to_arrival,closed_to_departure,min_stay_arrival,min_stay_through,max_stay)
     VALUES ${v}
     ON CONFLICT(hotel_code,room_type_id,rate_plan_id,date)
     DO UPDATE SET ${["stop_sell", "closed_to_arrival", "closed_to_departure", "min_stay_arrival", "min_stay_through", "max_stay"].map(keepAbsent).join(",")}`,
};

const LOG_INSERT: RowWrite = {
  cols: 11,
  sql: (v) => `INSERT INTO ari_log (hotel_code,ts,source,actor,kind,room_type_id,rate_plan_id,date,field,old_value,new_value) VALUES ${v}`,
};

/** Pack parameter tuples into as few statements as the cap allows. */
export function packUpserts(D: D1Database, w: RowWrite, rows: unknown[][]): D1PreparedStatement[] {
  return chunkRows(rows, w.cols).map((chunk) => D.prepare(w.sql(valuesTuples(chunk.length, w.cols))).bind(...chunk.flat()));
}

/** Insert change entries into the audit log (best-effort — never fail a write
 *  because logging hiccuped). `now` is passed so a whole batch shares a ts. */
export async function insertAriLog(hotelCode: string, actor: AriActor, entries: AriLogEntry[], now: number): Promise<void> {
  if (!entries.length) return;
  try {
    const D = db();
    const rows = entries.map((e) => [
      hotelCode, now, actor.source, actor.actor, e.kind, e.roomTypeId, e.ratePlanId, e.date, e.field, e.oldValue, e.newValue,
    ]);
    const stmts = packUpserts(D, LOG_INSERT, rows);
    for (let i = 0; i < stmts.length; i += 100) await D.batch(stmts.slice(i, i + 100));
  } catch (e) {
    console.log(`[ari-log] insert failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Run a write that touches the given dates, capturing before/after snapshots
 *  and logging the diff as `actor`. The snapshots cover exactly those dates —
 *  not the span from the earliest to the latest — and the diff is filtered to
 *  them as well, so an edit to 1 May and 1 September can no longer log every
 *  cell of the summer in between. Skipped entirely when there's nothing to
 *  change. */
export async function withAriLog<T>(
  hotelCode: string,
  actor: AriActor,
  dates: string[],
  write: () => Promise<T>,
): Promise<T> {
  if (dates.length === 0) return write();
  const touched = new Set(dates);
  const before = await getInventoryOn(hotelCode, touched);
  const result = await write();
  const after = await getInventoryOn(hotelCode, touched);
  await insertAriLog(hotelCode, actor, diffInventory(before, after, touched), Date.now());
  return result;
}
