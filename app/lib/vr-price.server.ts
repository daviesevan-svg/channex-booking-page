// Price suggestions for a single-unit rental (server side): assembles the pure
// rules in vr-price.ts from the market signals we capture (pace + comp prices)
// and the property's own ARI, and applies accepted suggestions through the same
// audited ARI path a manual edit uses — so changes flow to the change log and
// out to Google/Channex like any other price change.
//
// Price anchoring is shared with the hotel engine (getPriceBases/resolveBase):
// a suggestion always scales the cell's BASE price — what it was before revenue
// management first touched it — so re-applying can't compound, while a manual
// edit re-anchors the base to the host's new price.
import { getConfigKV, getDB } from "./config.server";
import { getInventory, saveInventory, type AriActor, type InventoryEdits } from "./ari.server";
import { getSettings } from "./overrides.server";
import { getPriceBases, resolveBase } from "./revman-analytics.server";
import { guardsReady, targetPrice, type PriceGuards } from "./revman-price";
import { getMarketPace, getVrPrices } from "./vr-comp-capture.server";
import { suggestVrPrice, type PaceSignal, type VrSuggestion } from "./vr-price";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

const DAY = 86_400_000;
const shiftISO = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** How far ahead suggestions are produced. Availability is captured much
 *  further out, but pricing decisions beyond ~90 days are rarely actionable. */
export const VR_SUGGESTION_DAYS = 90;

// ---------------------------------------------------------------------------
// Guards (KV). Kept separate from the hotel guards, which live on the revman
// state a rental property may never have.

export async function getVrGuards(pid: string): Promise<PriceGuards> {
  const kv = getConfigKV();
  if (!kv) return {};
  const raw = await kv.get(`vrprice:${pid}`);
  if (!raw) return {};
  try {
    const g = JSON.parse(raw) as PriceGuards;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    return { minPrice: num(g.minPrice), maxPrice: num(g.maxPrice) };
  } catch {
    return {};
  }
}

export async function setVrGuards(pid: string, minPrice: number, maxPrice: number): Promise<void> {
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice <= 0 || maxPrice < minPrice) {
    throw new Error("Enter a minimum and maximum price, with the maximum at least the minimum.");
  }
  const kv = getConfigKV();
  if (kv) await kv.put(`vrprice:${pid}`, JSON.stringify({ minPrice, maxPrice }));
}

// ---------------------------------------------------------------------------
// Suggestions.

export interface VrPriceSuggestionRow extends VrSuggestion {
  paceSignal: PaceSignal;
  marketOccupancy: number | null;
  dba: number;
  /** Our lowest current price for the date (major units). */
  ownPrice?: number;
  marketMedian: number | null;
  marketCheapest: number | null;
  /** Our unit is sold for the date. */
  ownBooked: boolean;
  /** Absolute target for the lowest-priced cell (base × pct, clamped to
   *  guards). Undefined when guards aren't set, no price is loaded, or the
   *  date holds. */
  target?: number;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One suggestion per date over the suggestion window. */
export async function getVrPriceSuggestions(pid: string, today: string, guards: PriceGuards): Promise<VrPriceSuggestionRow[]> {
  const to = shiftISO(today, VR_SUGGESTION_DAYS - 1);
  const [pace, priceRows, inventory, bases] = await Promise.all([
    getMarketPace(pid, today, to, today),
    getVrPrices(pid, today, to),
    getInventory(pid, today, to),
    getPriceBases(pid, today, to),
  ]);

  // Comp price stats per date (minor units → major for comparison with ARI).
  const byDate = new Map<string, number[]>();
  for (const r of priceRows) {
    if (r.priceMinor == null) continue;
    const arr = byDate.get(r.date) ?? [];
    arr.push(r.priceMinor / 100);
    byDate.set(r.date, arr);
  }

  // Our own lowest-priced cell per date, and whether the unit is still sellable.
  const minCellByDate = new Map<string, { key: string; price: number }>();
  for (const [key, price] of Object.entries(inventory.prices)) {
    const date = key.split("|")[2];
    if (price > 0 && (minCellByDate.get(date)?.price ?? Infinity) > price) minCellByDate.set(date, { key, price });
  }
  // Single-unit: any availability at all means it's still open. Absent data is
  // treated as open rather than sold, so a missing row can't silently mute
  // every suggestion.
  const soldOut = new Map<string, boolean>();
  for (const [key, avail] of Object.entries(inventory.availability)) {
    const date = key.split("|")[1];
    soldOut.set(date, (soldOut.get(date) ?? true) && avail <= 0);
  }

  return pace.map((p) => {
    const comps = byDate.get(p.date) ?? [];
    const marketMedian = median(comps);
    const marketCheapest = comps.length ? Math.min(...comps) : null;
    const minCell = minCellByDate.get(p.date);
    const ownBooked = soldOut.get(p.date) === true;

    const suggestion = suggestVrPrice({
      date: p.date,
      paceSignal: p.signal,
      marketOccupancy: p.occupancy,
      dba: p.dba,
      ownPrice: minCell?.price,
      marketMedian,
      marketCheapest,
      ownBooked,
    });

    const target =
      minCell !== undefined && suggestion.pct !== 0 && guardsReady(guards)
        ? targetPrice(resolveBase(minCell.price, bases.get(minCell.key)), suggestion.pct, guards)
        : undefined;

    return {
      ...suggestion,
      paceSignal: p.signal,
      marketOccupancy: p.occupancy,
      dba: p.dba,
      ownPrice: minCell?.price,
      marketMedian,
      marketCheapest,
      ownBooked,
      target,
    };
  });
}

/** Applies the CURRENT suggestions for the given dates: every priced cell is set
 *  to its target (base × the date's pct, clamped to guards) through the audited
 *  ARI path. Re-applying is a no-op; a manual edit re-anchors the base. */
export async function applyVrPriceSuggestions(
  pid: string,
  dates: string[],
  today: string,
  guards: PriceGuards,
  actor: AriActor,
): Promise<{ dates: number; cells: number }> {
  if (!guardsReady(guards)) throw new Error("Set the minimum and maximum price guards first.");
  const suggestions = await getVrPriceSuggestions(pid, today, guards);
  const byDate = new Map(suggestions.map((s) => [s.date, s]));
  const wanted = new Set(dates);

  const to = shiftISO(today, VR_SUGGESTION_DAYS - 1);
  const [inventory, bases, settings] = await Promise.all([
    getInventory(pid, today, to),
    getPriceBases(pid, today, to),
    getSettings(pid),
  ]);

  const edits: InventoryEdits = { currency: settings.currency || "GBP", availability: [], prices: [], restrictions: [] };
  const upsertBase = db().prepare(
    `INSERT INTO rev_price_base (pid, room_id, rate_id, date, base, applied)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (pid, room_id, rate_id, date) DO UPDATE SET
       base = excluded.base, applied = excluded.applied`,
  );
  const baseStmts: D1PreparedStatement[] = [];
  const touchedDates = new Set<string>();

  for (const [key, price] of Object.entries(inventory.prices)) {
    const [roomId, rateId, date] = key.split("|");
    if (!wanted.has(date) || price <= 0) continue;
    const s = byDate.get(date);
    if (!s || s.pct === 0) continue;
    const base = resolveBase(price, bases.get(key));
    const next = targetPrice(base, s.pct, guards);
    // Record the anchor even when already at target, so later applies keep
    // resolving against the pre-suggestion base.
    baseStmts.push(upsertBase.bind(pid, roomId, rateId, date, base, next));
    if (next === price) continue;
    edits.prices.push({ roomId, rateId, date, price: next });
    touchedDates.add(date);
  }

  if (edits.prices.length > 0) await saveInventory(pid, edits, actor);
  baseStmts.push(db().prepare(`DELETE FROM rev_price_base WHERE pid = ? AND date < ?`).bind(pid, today));
  for (let i = 0; i < baseStmts.length; i += 90) await db().batch(baseStmts.slice(i, i + 90));
  return { dates: touchedDates.size, cells: edits.prices.length };
}
