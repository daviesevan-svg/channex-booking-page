// Occupancy forecast — pure, client-safe port of the RevPanda reference
// pipeline (Explorer/Polars dataframes there, plain arrays here).
//
// Per stay date, the booking history is reduced to demand features — trailing
// occupancy averages, same-weekday averages, lead-time pace/pickup as a share
// of rooms, lags and week-over-week deltas — and run through a linear
// regression whose coefficients were trained offline on real hotel data (kept
// verbatim from the reference). The result is clipped to [0,1] and corrected
// to never fall below what's already on the books.
//
// Differences from the reference, on purpose:
// - No cancellation timestamps exist in the public Channex API, so the as-of
//   reconstruction uses the current cancelled flag (correct for the product's
//   only case, as-of = today; backtests would need timestamps).
// - Missing feature values (not enough history for a window/lag) fall back to
//   0 instead of null-propagating — with short history the forecast leans on
//   the pace/pickup terms and the max(actual, forecast) floor.

export interface ForecastNight {
  stayDate: string;
  isCancelled: 0 | 1;
  /** Rate in MAJOR units (the trained coefficients expect e.g. 120, not 12000). */
  rateMajor: number;
  leadTime: number;
}

export interface ForecastDay {
  date: string;
  forecastPercent: number;
  /** Forecast occupancy % before the on-the-books floor was applied. */
  rawPercent: number;
  forecast: number;
  /** Active ONLINE nights already on the books for the date. */
  onBooks: number;
  /** Inferred offline nights on the books (0 when not inferable). */
  offlineOnBooks: number;
}

const COEF = {
  intercept: -0.02117,
  sma7: 0.153214,
  avgDow26: 0.170699,
  occLag7: 0.093308,
  occLag14: 0.031605,
  occLag28: 0.017876,
  pickup14: 0.855491,
  pickup30: 0.311087,
  pickup30Delta7: -0.018556,
  pace30: 0.467052,
  pace30Delta7: 0.133752,
  avgRateLag7: 0.00001,
  avgRateDelta7: 0.000009,
  cancelPctLag7: 0.001099,
  pickup7Share: 0.000001,
} as const;

/** Forecast lead-time buckets (NOT the pace-calendar buckets): counts use
 *  `lead >= bucket`, expressed as a share of rooms. */
const FC_BUCKETS = [0, 3, 7, 14, 30, 60] as const;

const dayMs = 86_400_000;
const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

const clip01 = (v: number) => Math.min(1, Math.max(0, v));
const mean = (vals: number[]): number => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);

interface DayFrame {
  date: string;
  occ: number; // active nights / rooms, clipped 0..1
  active: number;
  cancelPct: number;
  avgRate: number;
  pacePct: number[]; // per FC_BUCKETS, share of rooms
  pickupPct: number[];
}

/** Trailing mean of the N values BEFORE index i (the reference's
 *  shift(1) |> window_mean(N)); fewer available values → mean of what exists. */
function trailingMean(series: number[], i: number, n: number): number {
  const from = Math.max(0, i - n);
  if (i <= 0) return 0;
  return mean(series.slice(from, i));
}

/** Occupancy forecast for every date in [startDate, endDate]. `nights` should
 *  cover ~2 years before startDate for the long features to be meaningful.
 *  `offlineOnBooks` (inferred offline nights per date) does NOT feed the
 *  regression — the coefficients were trained on booking data — it only lifts
 *  the on-the-books floor so the forecast never sits below TOTAL demand. */
export function buildForecast(
  nights: ForecastNight[],
  startDate: string,
  endDate: string,
  roomCount: number,
  offlineOnBooks?: Record<string, number>,
): ForecastDay[] {
  const rooms = Math.max(1, roomCount);

  // Group by stay date.
  const byDate = new Map<string, ForecastNight[]>();
  for (const n of nights) {
    const arr = byDate.get(n.stayDate) ?? [];
    arr.push(n);
    byDate.set(n.stayDate, arr);
  }

  // Filled calendar from the earliest known stay (or a year before start, so
  // lag365 has room) through endDate.
  let calFrom = addDays(startDate, -730);
  for (const d of byDate.keys()) if (d < calFrom) calFrom = d;

  const frames: DayFrame[] = [];
  const index = new Map<string, number>();
  for (let d = calFrom; d <= endDate; d = addDays(d, 1)) {
    const rows = byDate.get(d) ?? [];
    const active = rows.filter((r) => !r.isCancelled);
    const activeLeads = active.map((r) => r.leadTime);
    const pacePct = FC_BUCKETS.map((b) => activeLeads.filter((v) => v >= b).length / rooms);
    const pickupPct = pacePct.map((v, i) => (i === pacePct.length - 1 ? v : v - pacePct[i + 1]));
    index.set(d, frames.length);
    frames.push({
      date: d,
      occ: clip01(active.length / rooms),
      active: active.length,
      cancelPct: rows.length ? (rows.length - active.length) / rows.length : 0,
      avgRate: mean(rows.map((r) => r.rateMajor)),
      pacePct,
      pickupPct,
    });
  }

  const occ = frames.map((f) => f.occ);
  const lag = (series: number[], i: number, by: number): number => (i - by >= 0 ? series[i - by] : 0);

  // Same-weekday positions for the avg_dow feature.
  const dowPositions = new Map<number, number[]>();
  frames.forEach((f, i) => {
    const dow = new Date(`${f.date}T00:00:00Z`).getUTCDay();
    const arr = dowPositions.get(dow) ?? [];
    arr.push(i);
    dowPositions.set(dow, arr);
  });

  const out: ForecastDay[] = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    const i = index.get(d);
    if (i === undefined) continue;
    const f = frames[i];

    // avg_dow_26: trailing mean of the previous 26 same-weekday occupancies.
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const positions = dowPositions.get(dow) ?? [];
    const pos = positions.indexOf(i);
    const dowOcc = positions.map((p) => occ[p]);
    const avgDow26 = trailingMean(dowOcc, pos, 26);

    const pickup7 = f.pickupPct[2];
    const pickup14 = f.pickupPct[3];
    const pickup30 = f.pickupPct[4];
    const pace30 = f.pacePct[4];
    const fPrev7 = i - 7 >= 0 ? frames[i - 7] : undefined;

    const raw =
      COEF.intercept +
      COEF.sma7 * trailingMean(occ, i, 7) +
      COEF.avgDow26 * avgDow26 +
      COEF.occLag7 * lag(occ, i, 7) +
      COEF.occLag14 * lag(occ, i, 14) +
      COEF.occLag28 * lag(occ, i, 28) +
      COEF.pickup14 * pickup14 +
      COEF.pickup30 * pickup30 +
      COEF.pickup30Delta7 * (pickup30 - (fPrev7?.pickupPct[4] ?? 0)) +
      COEF.pace30 * pace30 +
      COEF.pace30Delta7 * (pace30 - (fPrev7?.pacePct[4] ?? 0)) +
      COEF.avgRateLag7 * (fPrev7?.avgRate ?? 0) +
      COEF.avgRateDelta7 * (f.avgRate - (fPrev7?.avgRate ?? 0)) +
      COEF.cancelPctLag7 * (fPrev7?.cancelPct ?? 0) +
      COEF.pickup7Share * (pickup7 / (pickup30 + 1e-6));

    const rawPercent = clip01(Math.round(raw * 10000) / 10000);
    // Never forecast below what's already on the books — online AND inferred
    // offline together.
    const offline = offlineOnBooks?.[d] ?? 0;
    const totalOcc = clip01((f.active + offline) / rooms);
    const forecastPercent = Math.max(totalOcc, rawPercent);
    out.push({
      date: d,
      rawPercent,
      forecastPercent: Math.round(forecastPercent * 10000) / 10000,
      forecast: Math.round(forecastPercent * rooms),
      onBooks: f.active,
      offlineOnBooks: offline,
    });
  }
  return out;
}
