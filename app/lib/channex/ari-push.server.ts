// Pushing prices OUT to Channex, which is how a revenue-management decision
// reaches the OTAs. This writes to live inventory, so it is deliberately
// conservative:
//
//   - It only runs when the property has opted in (pushOnApply) AND has actually
//     selected Channex on the connectivity page. Otherwise it SIMULATES: the
//     payload is built and logged, nothing is sent.
//   - It sends only the cells revenue management just changed, never a blanket
//     re-push of the calendar.
//   - It sends every occupancy of each cell. Sending just the base occupancy
//     would clear per-person prices for any property that uses them.
//   - Every attempt is recorded (counts + error) so the admin page can show what
//     happened rather than failing silently.
import { getConfig, getDB, getConfigKV } from "../config.server";
import { isChannexConnected } from "../overrides.server";
import { getRevmanChannexAuth } from "../revman.server";
import { getRateLinkConfig } from "../revman-rate-link.server";
import {
  buildRestrictionValues,
  chunkValues,
  shiftOccupancyRates,
  type OccupancyRate,
  type PushCell,
  type RestrictionValue,
} from "./ari-push";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

/** One cell whose base price revenue management moved, with the size of the move
 *  in minor units — the per-occupancy rows shift by the same amount. */
export interface ChangedCell {
  roomId: string;
  rateId: string;
  date: string;
  /** newBase − oldBase, in minor units. */
  deltaMinor: number;
  /** The new base price in minor units, used when a cell has no per-occupancy
   *  rows of its own. */
  newBaseMinor: number;
}

export interface PushResult {
  /** True when a request was actually sent (or there was nothing to send). */
  ok: boolean;
  /** Values that would be / were sent. */
  values: number;
  /** Requests issued (0 when simulated). */
  requests: number;
  /** No live traffic: either not connected to Channex, or push is switched off. */
  simulated: boolean;
  /** Cells skipped because we hold no per-occupancy prices for them. */
  skipped: number;
  error?: string;
}

const LAST_PUSH_KEY = (pid: string) => `revpush:${pid}`;

export interface LastPush extends PushResult {
  at: string;
}

export async function getLastPush(pid: string): Promise<LastPush | undefined> {
  const raw = await getConfigKV()?.get(LAST_PUSH_KEY(pid));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as LastPush;
  } catch {
    return undefined;
  }
}

async function recordPush(pid: string, result: PushResult): Promise<void> {
  await getConfigKV()?.put(LAST_PUSH_KEY(pid), JSON.stringify({ ...result, at: new Date().toISOString() }));
}

/** Per-occupancy prices we hold for the given cells, keyed `roomId|rateId|date`.
 *  Only rows with a real occupancy (> 0) count: occupancy 0 is the synthetic
 *  "any occupancy" row our own admin edits write, not something Channex wants
 *  back. */
async function readOccupancyRates(
  pid: string,
  cells: ChangedCell[],
): Promise<Map<string, OccupancyRate[]>> {
  const out = new Map<string, OccupancyRate[]>();
  if (cells.length === 0) return out;
  const dates = [...new Set(cells.map((c) => c.date))].sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  const { results } = await db()
    .prepare(
      `SELECT room_type_id AS roomId, rate_plan_id AS rateId, date, occupancy, price_minor AS priceMinor
       FROM rate WHERE hotel_code = ? AND date >= ? AND date <= ? AND occupancy > 0`,
    )
    .bind(pid, from, to)
    .all<{ roomId: string; rateId: string; date: string; occupancy: number; priceMinor: number }>();
  for (const r of results ?? []) {
    const key = `${r.roomId}|${r.rateId}|${r.date}`;
    const list = out.get(key) ?? [];
    list.push({ occupancy: Number(r.occupancy), rateMinor: Number(r.priceMinor) });
    out.set(key, list);
  }
  return out;
}

/** Applies the same base-price delta to every occupancy row of the changed
 *  cells, so our stored per-person prices stay consistent with the new base
 *  instead of going stale. Returns the shifted rates per cell. */
export async function shiftStoredOccupancyRates(
  pid: string,
  cells: ChangedCell[],
): Promise<Map<string, OccupancyRate[]>> {
  const current = await readOccupancyRates(pid, cells);
  const shifted = new Map<string, OccupancyRate[]>();
  const stmts: D1PreparedStatement[] = [];
  const upsert = db().prepare(
    `INSERT INTO rate (hotel_code,room_type_id,rate_plan_id,date,occupancy,price_minor,currency,fraction_size)
     VALUES (?,?,?,?,?,?,(SELECT currency FROM rate WHERE hotel_code=? AND room_type_id=? AND rate_plan_id=? AND date=? AND occupancy=? LIMIT 1),2)
     ON CONFLICT(hotel_code,room_type_id,rate_plan_id,date,occupancy)
     DO UPDATE SET price_minor=excluded.price_minor`,
  );
  for (const cell of cells) {
    const key = `${cell.roomId}|${cell.rateId}|${cell.date}`;
    const rates = current.get(key);
    if (!rates || rates.length === 0) continue;
    const next = shiftOccupancyRates(rates, cell.deltaMinor);
    shifted.set(key, next);
    for (const r of next) {
      stmts.push(
        upsert.bind(
          pid, cell.roomId, cell.rateId, cell.date, r.occupancy, r.rateMinor,
          pid, cell.roomId, cell.rateId, cell.date, r.occupancy,
        ),
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 90) await db().batch(stmts.slice(i, i + 90));
  return shifted;
}

/** Pushes the given changed cells to Channex. Shifts the stored per-occupancy
 *  prices first, so what we send is exactly what we hold. */
export async function pushPricesToChannex(pid: string, cells: ChangedCell[]): Promise<PushResult> {
  const shifted = await shiftStoredOccupancyRates(pid, cells);

  // Cells with no per-occupancy prices can't be pushed: Channex needs an
  // occupancy for every rate, and inventing one risks overwriting real prices.
  const pushCells: PushCell[] = [];
  let skipped = 0;
  for (const cell of cells) {
    const rates = shifted.get(`${cell.roomId}|${cell.rateId}|${cell.date}`);
    if (!rates || rates.length === 0) {
      skipped++;
      continue;
    }
    pushCells.push({ rateId: cell.rateId, date: cell.date, rates });
  }

  const [cfg, connected, auth] = await Promise.all([
    getRateLinkConfig(pid),
    isChannexConnected(pid),
    getRevmanChannexAuth(pid).catch(() => undefined),
  ]);

  const simulate = !cfg.pushOnApply || !connected || !auth;
  const values = auth ? buildRestrictionValues(auth.channexPropertyId, pushCells) : [];

  if (simulate) {
    const why = !cfg.pushOnApply ? "push disabled" : !connected ? "Channex not selected" : "no credentials";
    console.log(`[channex-push] simulated for ${pid} (${why}): ${values.length} values, ${skipped} cells skipped`);
    const result: PushResult = { ok: true, values: values.length, requests: 0, simulated: true, skipped };
    await recordPush(pid, result);
    return result;
  }

  const base = getConfig().apiUrl.replace(/\/+$/, "");
  let requests = 0;
  for (const chunk of chunkValues(values)) {
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1/restrictions`, {
        method: "POST",
        headers: { "user-api-key": (auth as { apiKey: string }).apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ values: chunk }),
      });
    } catch {
      const result: PushResult = { ok: false, values: values.length, requests, simulated: false, skipped, error: "Couldn't reach Channex." };
      await recordPush(pid, result);
      return result;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      const error =
        res.status === 401 || res.status === 403
          ? "Channex rejected the stored API key — reconnect revenue management."
          : `Channex returned ${res.status}${detail ? ` — ${detail}` : ""}`;
      const result: PushResult = { ok: false, values: values.length, requests, simulated: false, skipped, error };
      await recordPush(pid, result);
      return result;
    }
    requests++;
  }

  const result: PushResult = { ok: true, values: values.length, requests, simulated: false, skipped };
  await recordPush(pid, result);
  return result;
}

export type { RestrictionValue };
