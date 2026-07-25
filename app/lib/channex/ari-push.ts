// Building the payload for a Channex ARI price push — pure, so the shape can be
// tested without touching the network or a live property.
//
// Channex takes `POST /restrictions` with a `values` array, each entry covering
// one rate plan over one DATE RANGE, carrying a `rates` array of
// {occupancy, rate}. Rates are in MINOR units. Because a rate plan in Channex
// belongs to a single room type, the rate_plan_id alone identifies where the
// price lands — no room id in the payload.
//
// Two things this module is careful about:
//   - Per-occupancy prices are sent in full. Sending only the base occupancy
//     would clear the per-person prices of any property that uses them.
//   - Consecutive dates carrying an identical rates array are compressed into
//     one value, which is what keeps a 60-day push to a handful of requests.

export interface OccupancyRate {
  occupancy: number;
  /** Minor units, as stored. */
  rateMinor: number;
}

/** One cell we intend to push: a rate plan on a date, with every occupancy. */
export interface PushCell {
  rateId: string;
  date: string;
  rates: OccupancyRate[];
}

export interface RestrictionValue {
  property_id: string;
  rate_plan_id: string;
  date_from: string;
  date_to: string;
  rates: { occupancy: number; rate: number }[];
}

const DAY = 86_400_000;
const nextDay = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** Canonical form of a rates array, for equality checks and output: sorted by
 *  occupancy so two cells that differ only in ordering still compress. */
function normalizeRates(rates: OccupancyRate[]): { occupancy: number; rate: number }[] {
  return [...rates]
    .filter((r) => Number.isFinite(r.occupancy) && Number.isFinite(r.rateMinor) && r.rateMinor > 0)
    .sort((a, b) => a.occupancy - b.occupancy)
    .map((r) => ({ occupancy: r.occupancy, rate: Math.round(r.rateMinor) }));
}

const ratesKey = (rates: { occupancy: number; rate: number }[]): string =>
  rates.map((r) => `${r.occupancy}:${r.rate}`).join(",");

/** Groups cells into Channex values, compressing runs of consecutive dates that
 *  carry identical prices. Cells with no usable prices are dropped. */
export function buildRestrictionValues(propertyId: string, cells: PushCell[]): RestrictionValue[] {
  const byRate = new Map<string, { date: string; rates: { occupancy: number; rate: number }[]; key: string }[]>();
  for (const cell of cells) {
    const rates = normalizeRates(cell.rates);
    if (rates.length === 0) continue;
    const list = byRate.get(cell.rateId) ?? [];
    list.push({ date: cell.date, rates, key: ratesKey(rates) });
    byRate.set(cell.rateId, list);
  }

  const values: RestrictionValue[] = [];
  for (const [rateId, list] of byRate) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    let run: { from: string; to: string; rates: { occupancy: number; rate: number }[]; key: string } | null = null;
    for (const row of list) {
      if (run && run.key === row.key && nextDay(run.to) === row.date) {
        run.to = row.date;
        continue;
      }
      if (run) values.push({ property_id: propertyId, rate_plan_id: rateId, date_from: run.from, date_to: run.to, rates: run.rates });
      run = { from: row.date, to: row.date, rates: row.rates, key: row.key };
    }
    if (run) values.push({ property_id: propertyId, rate_plan_id: rateId, date_from: run.from, date_to: run.to, rates: run.rates });
  }
  return values;
}

/** Channex caps how much one request may carry; chunk the values accordingly. */
export const VALUES_PER_REQUEST = 100;

export function chunkValues<T>(values: T[], size = VALUES_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Shifts every occupancy of a cell by the same absolute amount. Per-person
 *  pricing in this app is expressed as fixed amounts (extra adult, single-guest
 *  discount, per-child bands), so a base price move must leave those
 *  supplements intact rather than scaling them. */
export function shiftOccupancyRates(rates: OccupancyRate[], deltaMinor: number): OccupancyRate[] {
  return rates.map((r) => ({ occupancy: r.occupancy, rateMinor: Math.max(0, Math.round(r.rateMinor + deltaMinor)) }));
}
