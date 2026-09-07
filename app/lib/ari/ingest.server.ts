// The Channex webhook ingest surface: the api-key gate, applying
// changes_notification pushes, and the "have we ever / when did we last
// receive ARI" reads that describe ingest state.
import { googleAriRepairStatements } from "../google-ari/repair.server";
import { getConfig, getConfigKV } from "../config.server";
import { d1Retry, db } from "../d1.server";
import { timingSafeEqual } from "../hmac.server";
import { toMinor } from "./fraction";
import { CHANNEX_ACTOR } from "./log.server";
import { getInventoryForScope, type InventoryScope } from "./read.server";
import { ensureSchema, type InventoryData } from "./schema.server";
import { AVAIL_UPSERT, RATE_UPSERT, RESTR_ENSURE, RESTR_UPSERT, diffInventory, insertAriLog, packUpserts } from "./write.server";

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

/** Inclusive list of YYYY-MM-DD dates from `from` to `to`. */
function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// Bindings for partial restriction changes: absent (or null) means "field not
// in this change", carried as the -1 sentinel so the upsert keeps the stored
// value (see RESTR_UPSERT in write.server.ts).
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
export async function applyChanges(body: unknown, options?: { repairRevision: string }): Promise<{ availability: number; rates: number; restrictions: number }> {
  await d1Retry(() => ensureSchema());
  const notifications = (body as { data?: unknown })?.data;
  if (!Array.isArray(notifications)) throw new Error("Expected { data: [...] }");

  const counts = { availability: 0, rates: 0, restrictions: 0 };
  const hotels = new Set<string>();
  // Only availability and displayed prices are audited. Keep the exact
  // room/product cells so concurrent writes elsewhere cannot enter this diff.
  const touched = new Map<string, InventoryScope>();
  const touch = (hotel: string, roomId: string, rateId: string | null, dates: string[]) => {
    if (!hotel || !dates.length) return;
    let scope = touched.get(hotel);
    if (!scope) touched.set(hotel, (scope = { availability: [], products: [] }));
    if (rateId === null) {
      let cell = scope.availability.find((c) => c.roomId === roomId);
      if (!cell) scope.availability.push((cell = { roomId, dates: [] }));
      cell.dates = [...new Set([...cell.dates, ...dates])];
    } else {
      let cell = scope.products.find((c) => c.roomId === roomId && c.rateId === rateId);
      if (!cell) scope.products.push((cell = { roomId, rateId, dates: [] }));
      cell.dates = [...new Set([...cell.dates, ...dates])];
    }
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


      if (type === "availability_changes") {
        touch(hotel, room, null, dates);
        const avail = Number(a.availability) || 0;
        for (const d of dates) {
          availRows.push([hotel, room, d, avail]);
          counts.availability++;
        }
      } else if (type === "restriction_changes") {
        const rates = (Array.isArray(a.rates) ? a.rates : []) as RateIn[];
        if (rates.length) touch(hotel, room, plan, dates);
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
    // upsert runs (see RESTR_ENSURE in write.server.ts).
    ...packUpserts(D, RESTR_ENSURE, restrEnsureRows),
    ...packUpserts(D, RESTR_UPSERT, restrRows),
  ];

  // Snapshot the affected windows before applying, so we can log what actually
  // changed (Channex re-sends unchanged values; diffInventory drops those).
  //
  // A hotel with no usable snapshot is left OUT of the map rather than falling
  // back to an empty one: diffing against empty would log every value in the
  // window as newly set. The write below does not depend on this, so a D1
  // failure here costs an audit entry, never an availability update.
  const before = new Map<string, InventoryData>();
  for (const [h, scope] of touched) {
    try {
      before.set(h, await d1Retry(() => getInventoryForScope(h, scope, false)));
    } catch (e) {
      console.log(`[ari] pre-change snapshot failed for ${h}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // D1 batches are atomic; chunk to stay well within limits on big ranges.
  // Retried on a transient failure — this is the write that stops us selling
  // inventory Channex has already closed, and Channex does not re-send a change
  // it considers delivered. An overbooking on 2026-10-03 came from exactly this
  // batch dying on "this D1 DB instance is no longer active" and no one asking
  // again. Re-applying a chunk that did commit is a no-op (upsert by PK).
  for (let i = 0; i < stmts.length; i += 100) {
    const chunk = stmts.slice(i, i + 100);
    // The marker rides with the LAST chunk: once every upsert has committed,
    // the change exists and Google must hear about it. Earlier chunks that
    // commit before a crash are re-applied by Channex's retry of the 5xx.
    if (options?.repairRevision && i + 100 >= stmts.length) chunk.push(...googleAriRepairStatements(D, hotels, options.repairRevision));
    await d1Retry(() => D.batch(chunk));
  }

  // Audit log: diff each hotel's window after applying, attributed to Channex.
  // Best-effort, and deliberately after the write: the ARI is already committed
  // by this point, so a failure here must not be reported to Channex as a failed
  // push (which would leave us holding data we told them we had not stored).
  const ts = Date.now();
  for (const [h, scope] of touched) {
    const snapshot = before.get(h);
    if (!snapshot) continue;
    try {
      const after = await d1Retry(() => getInventoryForScope(h, scope, false));
      await d1Retry(() => insertAriLog(h, CHANNEX_ACTOR, diffInventory(snapshot, after), ts));
    } catch (e) {
      console.log(`[ari] audit log failed for ${h}: ${e instanceof Error ? e.message : e}`);
    }
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
