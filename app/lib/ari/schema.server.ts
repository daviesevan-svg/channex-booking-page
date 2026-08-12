// Open Channel ARI store. Channex pushes availability/rates/restrictions to
// POST /api/changes; we upsert them into D1 and read slices on demand at search
// time. See https://docs.channex.io/for-ota/open-channel-api.
//
// This module owns the D1 schema — the table DDL and the create-once latch —
// plus the row shapes shared across the ari/ modules. Everything that touches
// these tables must await the SAME ensureSchema below; a second latch would
// fire its own CREATE batch.
import { schemaOnce } from "../d1.server";

/** Idempotently create the ARI tables. Cheap to call per request; runs once per
 *  isolate. (Formal D1 migrations can replace this for production.) */
export const ensureSchema = schemaOnce((d) => [
  d.prepare(
    // Availability is per room-type (rate plans of a room share inventory).
    `CREATE TABLE IF NOT EXISTS availability (
      hotel_code TEXT NOT NULL, room_type_id TEXT NOT NULL,
      date TEXT NOT NULL, avail INTEGER NOT NULL,
      PRIMARY KEY (hotel_code, room_type_id, date)
    )`,
  ),
  d.prepare(
    `CREATE TABLE IF NOT EXISTS rate (
      hotel_code TEXT NOT NULL, room_type_id TEXT NOT NULL, rate_plan_id TEXT NOT NULL,
      date TEXT NOT NULL, occupancy INTEGER NOT NULL DEFAULT 0,
      price_minor INTEGER NOT NULL, currency TEXT NOT NULL, fraction_size INTEGER NOT NULL DEFAULT 2,
      PRIMARY KEY (hotel_code, room_type_id, rate_plan_id, date, occupancy)
    )`,
  ),
  d.prepare(
    `CREATE TABLE IF NOT EXISTS restriction (
      hotel_code TEXT NOT NULL, room_type_id TEXT NOT NULL, rate_plan_id TEXT NOT NULL,
      date TEXT NOT NULL,
      stop_sell INTEGER NOT NULL DEFAULT 0, closed_to_arrival INTEGER NOT NULL DEFAULT 0,
      closed_to_departure INTEGER NOT NULL DEFAULT 0, min_stay_arrival INTEGER NOT NULL DEFAULT 0,
      min_stay_through INTEGER NOT NULL DEFAULT 0, max_stay INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hotel_code, room_type_id, rate_plan_id, date)
    )`,
  ),
  d.prepare(
    `CREATE TABLE IF NOT EXISTS catalog (
      hotel_code TEXT NOT NULL, room_type_id TEXT NOT NULL, room_title TEXT,
      rate_plan_id TEXT NOT NULL, rate_title TEXT, sell_mode TEXT, max_persons INTEGER,
      currency TEXT, read_only INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hotel_code, room_type_id, rate_plan_id)
    )`,
  ),
  d.prepare(
    // Audit trail: one row per changed value (availability / price /
    // restriction), recording who changed it (a user email or "Channex") and
    // when. Only real changes are logged (see diffInventory in
    // write.server.ts). `ts` is epoch ms.
    `CREATE TABLE IF NOT EXISTS ari_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_code TEXT NOT NULL, ts INTEGER NOT NULL,
      source TEXT NOT NULL, actor TEXT NOT NULL,
      kind TEXT NOT NULL, room_type_id TEXT NOT NULL, rate_plan_id TEXT,
      date TEXT NOT NULL, field TEXT NOT NULL,
      old_value TEXT, new_value TEXT
    )`,
  ),
  d.prepare(
    `CREATE INDEX IF NOT EXISTS ari_log_search ON ari_log (hotel_code, date, room_type_id, rate_plan_id)`,
  ),
  d.prepare(`CREATE INDEX IF NOT EXISTS ari_log_recent ON ari_log (hotel_code, ts)`),
]);

export interface MappingRoomType {
  id: string;
  title: string;
  rate_plans: { id: string; title: string; sell_mode: string; max_persons: number; currency: string; read_only: boolean }[];
}

// ---- inventory grid (admin-editable ARI) ----
export interface RestrictionCell {
  stopSell: boolean;
  minStay: number;
  /** closed to arrival — can't start a stay on this date */
  cta: boolean;
  /** closed to departure — can't end a stay on this date */
  ctd: boolean;
}

export interface InventoryData {
  /** key `${roomId}|${date}` → units available */
  availability: Record<string, number>;
  /** key `${roomId}|${rateId}|${date}` → price in major currency units */
  prices: Record<string, number>;
  /** key `${roomId}|${rateId}|${date}` → every stored price by occupancy.
   *  Occupancy ≥ 1 rows are Channex per-person pushes (price for that many
   *  adults); occupancy 0 is a manual edit. Only per-person rates read this —
   *  everything else uses the collapsed `prices` above. */
  pricesByOcc: Record<string, Record<number, number>>;
  /** key `${roomId}|${rateId}|${date}` → restriction flags */
  restrictions: Record<string, RestrictionCell>;
}
