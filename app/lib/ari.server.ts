// Open Channel ARI store. Channex pushes availability/rates/restrictions to
// POST /api/changes; we upsert them into D1 and read slices on demand at search
// time. See https://docs.channex.io/for-ota/open-channel-api.
import { getConfig, getConfigKV, getDB } from "./config.server";
import { timingSafeEqual } from "./hmac.server";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

/** Validates the `api-key` header Channex sends. Returns null when OK, or a
 *  Response to return when the key is missing/wrong. */
export function checkApiKey(request: Request): Response | null {
  const expected = getConfig().openChannelApiKey;
  const got = request.headers.get("api-key");
  // Constant-time compare (like the Stripe/webhook paths) so the shared key
  // can't be probed byte-by-byte via response timing.
  if (!expected || !got || !timingSafeEqual(got, expected)) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

let schemaReady = false;
/** Idempotently create the ARI tables. Cheap to call per request; runs once per
 *  isolate. (Formal D1 migrations can replace this for production.) */
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db().batch([
    db().prepare(
      // Availability is per room-type (rate plans of a room share inventory).
      `CREATE TABLE IF NOT EXISTS availability (
        hotel_code TEXT NOT NULL, room_type_id TEXT NOT NULL,
        date TEXT NOT NULL, avail INTEGER NOT NULL,
        PRIMARY KEY (hotel_code, room_type_id, date)
      )`,
    ),
    db().prepare(
      `CREATE TABLE IF NOT EXISTS rate (
        hotel_code TEXT NOT NULL, room_type_id TEXT NOT NULL, rate_plan_id TEXT NOT NULL,
        date TEXT NOT NULL, occupancy INTEGER NOT NULL DEFAULT 0,
        price_minor INTEGER NOT NULL, currency TEXT NOT NULL, fraction_size INTEGER NOT NULL DEFAULT 2,
        PRIMARY KEY (hotel_code, room_type_id, rate_plan_id, date, occupancy)
      )`,
    ),
    db().prepare(
      `CREATE TABLE IF NOT EXISTS restriction (
        hotel_code TEXT NOT NULL, room_type_id TEXT NOT NULL, rate_plan_id TEXT NOT NULL,
        date TEXT NOT NULL,
        stop_sell INTEGER NOT NULL DEFAULT 0, closed_to_arrival INTEGER NOT NULL DEFAULT 0,
        closed_to_departure INTEGER NOT NULL DEFAULT 0, min_stay_arrival INTEGER NOT NULL DEFAULT 0,
        min_stay_through INTEGER NOT NULL DEFAULT 0, max_stay INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hotel_code, room_type_id, rate_plan_id, date)
      )`,
    ),
    db().prepare(
      `CREATE TABLE IF NOT EXISTS catalog (
        hotel_code TEXT NOT NULL, room_type_id TEXT NOT NULL, room_title TEXT,
        rate_plan_id TEXT NOT NULL, rate_title TEXT, sell_mode TEXT, max_persons INTEGER,
        currency TEXT, read_only INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hotel_code, room_type_id, rate_plan_id)
      )`,
    ),
  ]);
  schemaReady = true;
}

/** Inclusive list of YYYY-MM-DD dates from `from` to `to`. */
function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const toMinor = (rate: string, fraction = 2) => Math.round(Number(rate) * 10 ** fraction);
const bit = (v: unknown) => (v ? 1 : 0);

interface RateIn {
  rate: string;
  currency: string;
  fraction_size?: number;
  occupancy?: number;
}
type ChangeAttrs = Record<string, unknown>;

/** KV key holding the epoch-ms of the last ARI push we received for a hotel. */
const lastAriKey = (hotelCode: string) => `ari:last-received:${hotelCode}`;

/** When Channex last pushed ARI to us, as epoch ms (null if never / on error).
 *  Used to show "last updated" on the connectivity page. */
export async function getLastAriReceivedAt(hotelCode: string): Promise<number | null> {
  if (!hotelCode) return null;
  try {
    const v = await getConfigKV().get(lastAriKey(hotelCode));
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Apply one or more changes_notification messages. Returns counts by type. */
export async function applyChanges(body: unknown): Promise<{ availability: number; rates: number; restrictions: number }> {
  await ensureSchema();
  const notifications = (body as { data?: unknown })?.data;
  if (!Array.isArray(notifications)) throw new Error("Expected { data: [...] }");

  const stmts: D1PreparedStatement[] = [];
  const counts = { availability: 0, rates: 0, restrictions: 0 };
  const hotels = new Set<string>();
  const D = db();

  const availStmt = D.prepare(
    `INSERT INTO availability (hotel_code,room_type_id,date,avail) VALUES (?,?,?,?)
     ON CONFLICT(hotel_code,room_type_id,date) DO UPDATE SET avail=excluded.avail`,
  );
  const rateStmt = D.prepare(
    `INSERT INTO rate (hotel_code,room_type_id,rate_plan_id,date,occupancy,price_minor,currency,fraction_size)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(hotel_code,room_type_id,rate_plan_id,date,occupancy)
     DO UPDATE SET price_minor=excluded.price_minor,currency=excluded.currency,fraction_size=excluded.fraction_size`,
  );
  const restrStmt = D.prepare(
    `INSERT INTO restriction (hotel_code,room_type_id,rate_plan_id,date,stop_sell,closed_to_arrival,closed_to_departure,min_stay_arrival,min_stay_through,max_stay)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(hotel_code,room_type_id,rate_plan_id,date)
     DO UPDATE SET stop_sell=excluded.stop_sell,closed_to_arrival=excluded.closed_to_arrival,closed_to_departure=excluded.closed_to_departure,min_stay_arrival=excluded.min_stay_arrival,min_stay_through=excluded.min_stay_through,max_stay=excluded.max_stay`,
  );

  for (const note of notifications) {
    const attrs = (note as { attributes?: ChangeAttrs }).attributes ?? {};
    const hotel = String(attrs.hotel_code ?? "");
    if (hotel) hotels.add(hotel);
    const changes = Array.isArray(attrs.changes) ? attrs.changes : [];
    for (const change of changes) {
      const type = (change as { type?: string }).type;
      const a = ((change as { attributes?: ChangeAttrs }).attributes ?? {}) as ChangeAttrs;
      const room = String(a.room_type_id ?? "");
      const plan = String(a.rate_plan_id ?? "");
      const dates = eachDate(String(a.date_from), String(a.date_to));

      if (type === "availability_changes") {
        const avail = Number(a.availability) || 0;
        for (const d of dates) {
          stmts.push(availStmt.bind(hotel, room, d, avail));
          counts.availability++;
        }
      } else if (type === "restriction_changes") {
        const rates = (Array.isArray(a.rates) ? a.rates : []) as RateIn[];
        for (const d of dates) {
          for (const r of rates) {
            stmts.push(
              rateStmt.bind(hotel, room, plan, d, Number(r.occupancy) || 0, toMinor(r.rate, r.fraction_size ?? 2), r.currency, r.fraction_size ?? 2),
            );
            counts.rates++;
          }
          stmts.push(
            restrStmt.bind(
              hotel, room, plan, d,
              bit(a.stop_sell), bit(a.closed_to_arrival), bit(a.closed_to_departure),
              Number(a.min_stay_arrival) || 0, Number(a.min_stay_through) || 0, Number(a.max_stay) || 0,
            ),
          );
          counts.restrictions++;
        }
      }
    }
  }

  // D1 batches are atomic; chunk to stay well within limits on big ranges.
  for (let i = 0; i < stmts.length; i += 100) {
    await D.batch(stmts.slice(i, i + 100));
  }

  // Record "last received" per hotel once the writes land (best-effort — a KV
  // hiccup must never fail an ARI push). Only stamp hotels that actually had
  // changes applied, so an empty/no-op notification doesn't move the marker.
  if (stmts.length > 0 && hotels.size > 0) {
    const now = String(Date.now());
    await Promise.all(
      [...hotels].map((h) => getConfigKV().put(lastAriKey(h), now).catch(() => {})),
    );
  }
  return counts;
}

/** True once we've actually received an ARI push for this hotel — i.e. Channex
 *  has sent availability or rates into D1, not merely that the connection was
 *  toggled on. Used to treat a property as genuinely live/sellable via Channex.
 *  ensureSchema first so an all-empty account returns false instead of throwing. */
export async function hasReceivedAri(hotelCode: string): Promise<boolean> {
  if (!hotelCode) return false;
  await ensureSchema();
  const D = db();
  const avail = await D.prepare(`SELECT 1 AS x FROM availability WHERE hotel_code=? LIMIT 1`)
    .bind(hotelCode)
    .first<{ x: number }>();
  if (avail) return true;
  const rate = await D.prepare(`SELECT 1 AS x FROM rate WHERE hotel_code=? LIMIT 1`)
    .bind(hotelCode)
    .first<{ x: number }>();
  return Boolean(rate);
}

export interface AriRow {
  room_type_id: string;
  rate_plan_id: string;
  date: string;
  occupancy: number;
  price_minor: number;
  currency: string;
  fraction_size: number;
  avail: number | null;
  stop_sell: number;
}

/** Bookable rate rows for a stay window [checkin, checkout) — joins rate with
 *  availability/restrictions and drops stop-sold dates. */
export async function queryRates(hotelCode: string, checkin: string, checkout: string): Promise<AriRow[]> {
  await ensureSchema();
  const res = await db()
    .prepare(
      `SELECT r.room_type_id, r.rate_plan_id, r.date, r.occupancy, r.price_minor, r.currency, r.fraction_size,
              a.avail AS avail, COALESCE(x.stop_sell,0) AS stop_sell
       FROM rate r
       LEFT JOIN availability a ON a.hotel_code=r.hotel_code AND a.room_type_id=r.room_type_id AND a.date=r.date
       LEFT JOIN restriction x ON x.hotel_code=r.hotel_code AND x.room_type_id=r.room_type_id AND x.rate_plan_id=r.rate_plan_id AND x.date=r.date
       WHERE r.hotel_code=? AND r.date>=? AND r.date<?
       ORDER BY r.room_type_id, r.rate_plan_id, r.occupancy, r.date`,
    )
    .bind(hotelCode, checkin, checkout)
    .all<AriRow>();
  return res.results ?? [];
}

export interface MappingRoomType {
  id: string;
  title: string;
  rate_plans: { id: string; title: string; sell_mode: string; max_persons: number; currency: string; read_only: boolean }[];
}

/** room_types + nested rate_plans for GET /api/mapping_details. */
export async function getMappingDetails(hotelCode: string): Promise<MappingRoomType[]> {
  await ensureSchema();
  const res = await db()
    .prepare(
      `SELECT room_type_id, room_title, rate_plan_id, rate_title, sell_mode, max_persons, currency, read_only
       FROM catalog WHERE hotel_code=? ORDER BY room_title, rate_title`,
    )
    .bind(hotelCode)
    .all<{
      room_type_id: string; room_title: string | null; rate_plan_id: string; rate_title: string | null;
      sell_mode: string | null; max_persons: number | null; currency: string | null; read_only: number;
    }>();

  const byRoom = new Map<string, MappingRoomType>();
  for (const r of res.results ?? []) {
    let rt = byRoom.get(r.room_type_id);
    if (!rt) {
      rt = { id: r.room_type_id, title: r.room_title ?? r.room_type_id, rate_plans: [] };
      byRoom.set(r.room_type_id, rt);
    }
    rt.rate_plans.push({
      id: r.rate_plan_id,
      title: r.rate_title ?? r.rate_plan_id,
      sell_mode: r.sell_mode ?? "per_room",
      max_persons: r.max_persons ?? 0,
      currency: r.currency ?? "GBP",
      read_only: Boolean(r.read_only),
    });
  }
  return [...byRoom.values()];
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
  /** key `${roomId}|${rateId}|${date}` → restriction flags */
  restrictions: Record<string, RestrictionCell>;
}

/** Read the ARI for a [from, to] inclusive window, as lookup maps. */
export async function getInventory(hotelCode: string, from: string, to: string): Promise<InventoryData> {
  await ensureSchema();
  const D = db();
  const [av, rt, rs] = await Promise.all([
    D.prepare(`SELECT room_type_id, date, avail FROM availability WHERE hotel_code=? AND date>=? AND date<=?`)
      .bind(hotelCode, from, to)
      .all<{ room_type_id: string; date: string; avail: number }>(),
    D.prepare(`SELECT room_type_id, rate_plan_id, date, occupancy, price_minor, fraction_size FROM rate WHERE hotel_code=? AND date>=? AND date<=?`)
      .bind(hotelCode, from, to)
      .all<{ room_type_id: string; rate_plan_id: string; date: string; occupancy: number; price_minor: number; fraction_size: number }>(),
    D.prepare(
      `SELECT room_type_id, rate_plan_id, date, stop_sell, min_stay_arrival, closed_to_arrival, closed_to_departure
       FROM restriction WHERE hotel_code=? AND date>=? AND date<=?`,
    )
      .bind(hotelCode, from, to)
      .all<{
        room_type_id: string;
        rate_plan_id: string;
        date: string;
        stop_sell: number;
        min_stay_arrival: number;
        closed_to_arrival: number;
        closed_to_departure: number;
      }>(),
  ]);

  const data: InventoryData = { availability: {}, prices: {}, restrictions: {} };
  for (const r of av.results ?? []) data.availability[`${r.room_type_id}|${r.date}`] = r.avail;
  // A rate may have several occupancy rows (per_person pushes from Channex);
  // prefer the manual occupancy=0 price, else the highest occupancy (the full rate).
  const priceOcc: Record<string, number> = {};
  for (const r of rt.results ?? []) {
    const key = `${r.room_type_id}|${r.rate_plan_id}|${r.date}`;
    const price = r.price_minor / 10 ** (r.fraction_size || 2);
    const prevOcc = priceOcc[key];
    if (prevOcc === undefined || r.occupancy === 0 || (prevOcc !== 0 && r.occupancy > prevOcc)) {
      data.prices[key] = price;
      priceOcc[key] = r.occupancy;
    }
  }
  for (const r of rs.results ?? [])
    data.restrictions[`${r.room_type_id}|${r.rate_plan_id}|${r.date}`] = {
      stopSell: Boolean(r.stop_sell),
      minStay: r.min_stay_arrival || 0,
      cta: Boolean(r.closed_to_arrival),
      ctd: Boolean(r.closed_to_departure),
    };
  return data;
}

export interface InventoryEdits {
  currency: string;
  availability: { roomId: string; date: string; avail: number }[];
  prices: { rateId: string; roomId: string; date: string; price: number }[];
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

/** Upsert manual ARI edits from the inventory grid. */
export async function saveInventory(hotelCode: string, edits: InventoryEdits): Promise<void> {
  await ensureSchema();
  const D = db();
  const availStmt = D.prepare(
    `INSERT INTO availability (hotel_code,room_type_id,date,avail) VALUES (?,?,?,?)
     ON CONFLICT(hotel_code,room_type_id,date) DO UPDATE SET avail=excluded.avail`,
  );
  const rateStmt = D.prepare(
    `INSERT INTO rate (hotel_code,room_type_id,rate_plan_id,date,occupancy,price_minor,currency,fraction_size)
     VALUES (?,?,?,?,0,?,?,2)
     ON CONFLICT(hotel_code,room_type_id,rate_plan_id,date,occupancy)
     DO UPDATE SET price_minor=excluded.price_minor,currency=excluded.currency`,
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
    stmts.push(rateStmt.bind(hotelCode, p.roomId, p.rateId, p.date, Math.round(p.price * 100), edits.currency));
  for (const r of edits.restrictions)
    stmts.push(
      restrStmt.bind(hotelCode, r.roomId, r.rateId, r.date, r.stopSell ? 1 : 0, r.minStay, r.cta ? 1 : 0, r.ctd ? 1 : 0),
    );

  for (let i = 0; i < stmts.length; i += 100) await D.batch(stmts.slice(i, i + 100));
}

export interface BulkScope {
  currency: string;
  /** target dates (already filtered to the chosen days of week) */
  dates: string[];
  /** rooms in scope — availability is set per room */
  rooms: { id: string }[];
  /** rates in scope — price + restrictions are set per (room, rate) it's priced on */
  rates: { id: string; prices: Record<string, number> }[];
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
export async function applyBulkUpdate(hotelCode: string, s: BulkScope): Promise<{ cells: number }> {
  if (!s.dates.length) return { cells: 0 };
  const edits: InventoryEdits = { currency: s.currency, availability: [], prices: [], restrictions: [] };

  if (s.avail !== undefined) {
    const avail = Math.max(0, Math.round(s.avail));
    for (const room of s.rooms) for (const date of s.dates) edits.availability.push({ roomId: room.id, date, avail });
  }

  const touchRestr = s.minStay !== undefined || s.stopSell !== undefined || s.cta !== undefined || s.ctd !== undefined;
  const touchPrice = s.price !== undefined && s.price > 0;
  if (touchPrice || touchRestr) {
    // Read the current window once so we can preserve restriction fields the
    // operator left blank.
    const existing = touchRestr
      ? await getInventory(hotelCode, s.dates[0], s.dates[s.dates.length - 1])
      : { availability: {}, prices: {}, restrictions: {} as Record<string, RestrictionCell> };
    for (const rate of s.rates) {
      for (const room of s.rooms) {
        if (rate.prices[room.id] === undefined) continue; // rate not offered on this room
        for (const date of s.dates) {
          if (touchPrice) edits.prices.push({ roomId: room.id, rateId: rate.id, date, price: s.price! });
          if (touchRestr) {
            const cur = existing.restrictions[`${room.id}|${rate.id}|${date}`];
            edits.restrictions.push({
              roomId: room.id,
              rateId: rate.id,
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

  await saveInventory(hotelCode, edits);
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
