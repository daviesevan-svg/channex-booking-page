// Open Channel ARI store. Channex pushes availability/rates/restrictions to
// POST /api/changes; we upsert them into D1 and read slices on demand at search
// time. See https://docs.channex.io/for-ota/open-channel-api.
import { getConfig, getConfigKV, getDB } from "./config.server";
import { chunkForBinds, chunkRows, placeholders, valuesTuples } from "./d1-limits";
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
    db().prepare(
      // Audit trail: one row per changed value (availability / price /
      // restriction), recording who changed it (a user email or "Channex") and
      // when. Only real changes are logged (see diffInventory). `ts` is epoch ms.
      `CREATE TABLE IF NOT EXISTS ari_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_code TEXT NOT NULL, ts INTEGER NOT NULL,
        source TEXT NOT NULL, actor TEXT NOT NULL,
        kind TEXT NOT NULL, room_type_id TEXT NOT NULL, rate_plan_id TEXT,
        date TEXT NOT NULL, field TEXT NOT NULL,
        old_value TEXT, new_value TEXT
      )`,
    ),
    db().prepare(
      `CREATE INDEX IF NOT EXISTS ari_log_search ON ari_log (hotel_code, date, room_type_id, rate_plan_id)`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS ari_log_recent ON ari_log (hotel_code, ts)`),
  ]);
  schemaReady = true;
}

/** Who made an ARI change — a signed-in admin (their email) or Channex.
 *
 *  `"revman"` is LEGACY: revenue management was removed, so nothing writes it
 *  any more. It stays in the union so historical rows still render as what they
 *  actually were, rather than being relabelled as a person's edit. */
export interface AriActor {
  source: "user" | "channex" | "revman";
  /** Display label: the user's email, or "Channex". */
  actor: string;
}
export const CHANNEX_ACTOR: AriActor = { source: "channex", actor: "Channex" };

export interface AriLogEntry {
  // Only these two are written now; "restriction" rows exist from before that and
  // still have to READ back, which is why AriLogRow.kind stays a plain string.
  kind: "availability" | "price";
  roomTypeId: string;
  ratePlanId: string | null;
  date: string;
  // `avail` or `price`. The restriction fields (stop_sell, min_stay, cta, ctd)
  // are no longer written — see diffInventory — but still appear in rows recorded
  // before that, so anything RENDERING a field has to keep handling them until
  // they age out of the 30-day window.
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

const EMPTY_INVENTORY: InventoryData = { availability: {}, prices: {}, pricesByOcc: {}, restrictions: {} };

/** Diff two inventory snapshots into per-value change entries. Compares at the
 *  "displayed value" granularity (what getInventory exposes), so it's identical
 *  for user grid edits and Channex pushes and free of per-occupancy noise. */
function diffInventory(
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

interface RowWrite {
  /** Parameters per row — sets how many rows fit one statement. */
  cols: number;
  /** Full SQL, given the `(?,?),(?,?)` fragment. */
  sql: (values: string) => string;
}

const AVAIL_UPSERT: RowWrite = {
  cols: 4,
  sql: (v) => `INSERT INTO availability (hotel_code,room_type_id,date,avail) VALUES ${v}
     ON CONFLICT(hotel_code,room_type_id,date) DO UPDATE SET avail=excluded.avail`,
};

const RATE_UPSERT: RowWrite = {
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
const RESTR_ENSURE: RowWrite = {
  cols: 4,
  sql: (v) => `INSERT OR IGNORE INTO restriction (hotel_code,room_type_id,rate_plan_id,date) VALUES ${v}`,
};

const keepAbsent = (col: string) => `${col}=CASE WHEN excluded.${col}<0 THEN ${col} ELSE excluded.${col} END`;

const RESTR_UPSERT: RowWrite = {
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
function packUpserts(D: D1Database, w: RowWrite, rows: unknown[][]): D1PreparedStatement[] {
  return chunkRows(rows, w.cols).map((chunk) => D.prepare(w.sql(valuesTuples(chunk.length, w.cols))).bind(...chunk.flat()));
}

/** Insert change entries into the audit log (best-effort — never fail a write
 *  because logging hiccuped). `now` is passed so a whole batch shares a ts. */
async function insertAriLog(hotelCode: string, actor: AriActor, entries: AriLogEntry[], now: number): Promise<void> {
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
async function withAriLog<T>(
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

export interface AriLogRow {
  id: number;
  ts: number;
  source: string;
  actor: string;
  kind: string;
  roomTypeId: string;
  ratePlanId: string | null;
  date: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface AriLogFilter {
  /** exact affected date (YYYY-MM-DD) */
  date?: string;
  roomTypeId?: string;
  /** one rate can map to several Channex rate ids (consolidated plans), so this
   *  is a set — a row matches if its rate_plan_id is any of them. */
  ratePlanIds?: string[];
  limit?: number;
}

/** Search the ARI change log for a hotel, newest first. Filter by affected
 *  date, room type and/or rate plan. */
export async function queryAriLog(hotelCode: string, filter: AriLogFilter = {}): Promise<AriLogRow[]> {
  await ensureSchema();
  const where = ["hotel_code = ?"];
  const binds: (string | number)[] = [hotelCode];
  if (filter.date) {
    where.push("date = ?");
    binds.push(filter.date);
  }
  if (filter.roomTypeId) {
    where.push("room_type_id = ?");
    binds.push(filter.roomTypeId);
  }
  const limit = Math.min(1000, Math.max(1, filter.limit ?? 200));

  type LogRecord = {
    id: number; ts: number; source: string; actor: string; kind: string;
    room_type_id: string; rate_plan_id: string | null; date: string; field: string;
    old_value: string | null; new_value: string | null;
  };

  const run = async (idChunk: string[] | null): Promise<LogRecord[]> => {
    const clauses = [...where];
    const b = [...binds];
    if (idChunk) {
      clauses.push(`rate_plan_id IN (${placeholders(idChunk.length)})`);
      b.push(...idChunk);
    }
    const res = await db()
      .prepare(
        `SELECT id, ts, source, actor, kind, room_type_id, rate_plan_id, date, field, old_value, new_value
         FROM ari_log WHERE ${clauses.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .bind(...b, limit)
      .all<LogRecord>();
    return res.results ?? [];
  };

  // One rate maps to a Channex id per room, so this list grows with the room
  // count and can pass what D1 will bind (100 parameters, of which the WHERE
  // above and the LIMIT have already taken some). Chunking is exact here rather
  // than approximate: each chunk is asked for the same newest-`limit` rows, and
  // any row in the true newest-`limit` of the whole set is necessarily in the
  // newest-`limit` of its own chunk, so re-sorting the union and cutting to
  // `limit` gives the same answer one big query would have.
  let rows: LogRecord[];
  if (!filter.ratePlanIds?.length) {
    rows = await run(null);
  } else {
    const chunks = chunkForBinds(filter.ratePlanIds, binds.length + 1);
    rows = (await Promise.all(chunks.map(run))).flat();
    if (chunks.length > 1) {
      rows.sort((a, z) => z.ts - a.ts || z.id - a.id);
      rows = rows.slice(0, limit);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    source: r.source,
    actor: r.actor,
    kind: r.kind,
    roomTypeId: r.room_type_id,
    ratePlanId: r.rate_plan_id,
    date: r.date,
    field: r.field,
    oldValue: r.old_value,
    newValue: r.new_value,
  }));
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
// Bindings for partial restriction changes: absent (or null) means "field not
// in this change", carried as the -1 sentinel so the upsert keeps the stored
// value (see RESTR_UPSERT).
const ABSENT = -1;
const nbit = (v: unknown) => (v == null ? ABSENT : v ? 1 : 0);
const nnum = (v: unknown) => (v == null ? ABSENT : Number(v) || 0);

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

  const counts = { availability: 0, rates: 0, restrictions: 0 };
  const hotels = new Set<string>();
  // Per-hotel affected DATES, so we can snapshot/diff for the audit log. A set
  // rather than a {from,to} window: one notification body routinely carries
  // scattered dates, and widening to cover them meant snapshotting — and then
  // diffing — everything in between. With a 730-day horizon that turned a
  // two-date push into a two-year comparison, which is both a large read and a
  // way to attribute another writer's concurrent change to Channex.
  const touched = new Map<string, Set<string>>();
  const touch = (hotel: string, dates: string[]) => {
    if (!hotel || !dates.length) return;
    let set = touched.get(hotel);
    if (!set) touched.set(hotel, (set = new Set<string>()));
    for (const d of dates) set.add(d);
  };
  const D = db();

  // Rows are collected as parameter tuples and packed into multi-row INSERTs at
  // the end, rather than bound one statement per cell. A 730-day availability
  // push is 730 cells: as single-row statements that is 8 batched round trips,
  // as 25-row statements (4 parameters each, so 25 fits the 100-parameter cap)
  // it is 30 statements in one. Same rows, same order, same upsert.
  const availRows: unknown[][] = [];
  const rateRows: unknown[][] = [];
  const restrEnsureRows: unknown[][] = [];
  const restrRows: unknown[][] = [];

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
      touch(hotel, dates);

      if (type === "availability_changes") {
        const avail = Number(a.availability) || 0;
        for (const d of dates) {
          availRows.push([hotel, room, d, avail]);
          counts.availability++;
        }
      } else if (type === "restriction_changes") {
        const rates = (Array.isArray(a.rates) ? a.rates : []) as RateIn[];
        // Fields absent from this change bind the ABSENT sentinel → preserved
        // by the upsert. A rate-only change writes no restriction row at all.
        // Channex is configured to send ONE min-stay field, the generic
        // `min_stay` — deliberately, so there is a single number to reason
        // about. It lands in min_stay_arrival, the column the booking logic
        // reads (min_stay_through is never populated; catalog.server returns
        // {} for it). Reading only the arrival/through pair silently dropped
        // every min_stay: the field bound ABSENT, the upsert kept the stored 0,
        // and the change still counted as applied because stop_sell/cta/ctd
        // rode along in the same change. The specific field still wins if a
        // future channel sends it.
        const restr = [
          nbit(a.stop_sell), nbit(a.closed_to_arrival), nbit(a.closed_to_departure),
          nnum(a.min_stay_arrival ?? a.min_stay), nnum(a.min_stay_through), nnum(a.max_stay),
        ];
        const hasRestr = restr.some((f) => f !== ABSENT);
        for (const d of dates) {
          for (const r of rates) {
            rateRows.push([hotel, room, plan, d, Number(r.occupancy) || 0, toMinor(r.rate, r.fraction_size ?? 2), r.currency, r.fraction_size ?? 2]);
            counts.rates++;
          }
          if (hasRestr) {
            restrEnsureRows.push([hotel, room, plan, d]);
            restrRows.push([hotel, room, plan, d, ...restr]);
            counts.restrictions++;
          }
        }
      }
    }
  }

  const stmts = [
    ...packUpserts(D, AVAIL_UPSERT, availRows),
    ...packUpserts(D, RATE_UPSERT, rateRows),
    // Ensure-then-upsert order matters: rows must exist before the NULL-keep
    // upsert runs (see RESTR_ENSURE).
    ...packUpserts(D, RESTR_ENSURE, restrEnsureRows),
    ...packUpserts(D, RESTR_UPSERT, restrRows),
  ];

  // Snapshot the affected windows before applying, so we can log what actually
  // changed (Channex re-sends unchanged values; diffInventory drops those).
  const before = new Map<string, InventoryData>();
  for (const [h, ds] of touched) before.set(h, await getInventoryOn(h, ds));

  // D1 batches are atomic; chunk to stay well within limits on big ranges.
  for (let i = 0; i < stmts.length; i += 100) {
    await D.batch(stmts.slice(i, i + 100));
  }

  // Audit log: diff each hotel's window after applying, attributed to Channex.
  const ts = Date.now();
  for (const [h, ds] of touched) {
    const after = await getInventoryOn(h, ds);
    await insertAriLog(h, CHANNEX_ACTOR, diffInventory(before.get(h) ?? EMPTY_INVENTORY, after, ds), ts);
  }

  // Record "last received" per hotel once the writes land (best-effort — a KV
  // hiccup must never fail an ARI push). Only stamp hotels that actually had
  // changes applied, so an empty/no-op notification doesn't move the marker.
  if (stmts.length > 0 && hotels.size > 0) {
    const now = String(ts);
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

/** Read the ARI for a [from, to] inclusive window, as lookup maps. */
export async function getInventory(hotelCode: string, from: string, to: string): Promise<InventoryData> {
  return readInventory(hotelCode, [{ where: "date>=? AND date<=?", binds: [from, to] }]);
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
    const price = r.price_minor / 10 ** (r.fraction_size || 2);
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
   *  rateChannexId in catalog.server.ts — not imported here, it would cycle). */
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
