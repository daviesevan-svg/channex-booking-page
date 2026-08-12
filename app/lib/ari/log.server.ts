// The ARI audit log: who changed what, and the query the admin log page runs.
// The log WRITES live in write.server.ts (insertAriLog / withAriLog) so Channex
// ingest and admin edits share one code path; this module owns the types and
// the read side.
import { chunkForBinds, placeholders } from "../d1-limits";
import { db } from "../d1.server";
import { ensureSchema } from "./schema.server";

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
  // are no longer written — see diffInventory in write.server.ts — but still
  // appear in rows recorded before that, so anything RENDERING a field has to
  // keep handling them until they age out of the 30-day window.
  field: string;
  oldValue: string | null;
  newValue: string | null;
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
