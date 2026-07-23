// Booking pace / pickup scoring — pure, client-safe port of the RevPanda
// reference algorithm.
//
// For each stay date, on-the-books counts are bucketed by days-before-arrival
// (DBA) and compared against the same DBA snapshot one year ago (364 days =
// 52 whole weeks, so weekdays stay aligned). Pace (cumulative demand) and
// pickup (recent demand) are blended with DBA-dependent weights — near arrival
// short-term pickup is the meaningful signal, far out cumulative pace is — and
// the blend is scored on a log ratio (Haldane +1 smoothing keeps zeros stable).

/** The four pace-driven scores come from scoreOf; "sold_out" is an override
 *  applied downstream when total on-the-books demand (online + inferred
 *  offline) reaches capacity — a full date is never a sales problem, whatever
 *  its online pace says. */
export type SalesScore = "high_demand" | "steady_sales" | "slow_sales" | "needs_attention" | "sold_out";

/** DBA bucket upper bounds; the last entry catches everything beyond. */
export const PACE_BUCKETS = [0, 3, 7, 14, 30, 60, 90, 91] as const;

/** Per-bucket [pace, pickup] weights (same order as PACE_BUCKETS):
 *  DBA 0 → pure pace (final on-the-books level; pickup carries no signal);
 *  1–3 → pickup dominates (near-arrival elasticity decides);
 *  4–7 → pickup still stronger; 8–14 → transitional, slight tilt to pace;
 *  15–30 → structural demand, pace primary; 31+ → essentially pure pace. */
const BUCKET_WEIGHTS: readonly [number, number][] = [
  [1.0, 0.0],
  [0.3, 0.7],
  [0.4, 0.6],
  [0.55, 0.45],
  [0.7, 0.3],
  [0.85, 0.15],
  [0.95, 0.05],
  [1.0, 0.0],
];

export interface PaceSnapshot {
  date: string;
  /** Days before arrival at the as-of date (negative for past dates). */
  dba: number;
  bucketIndex: number;
  paceMatrix: number[];
  pickupMatrix: number[];
  paceMatrixLy: number[];
  pickupMatrixLy: number[];
  paceCur: number;
  paceLy: number;
  pickupCur: number;
  pickupLy: number;
  /** On-the-books difference vs last year at the same DBA. */
  salesAbs: number;
  wPace: number;
  wPickup: number;
  scoreRaw: number;
  score: SalesScore;
}

/** Cumulative on-the-books per bucket: index 0 = everything, index i = nights
 *  booked more than PACE_BUCKETS[i-1] days before the stay. */
export function buildPace(leadTimes: number[]): number[] {
  return PACE_BUCKETS.map((_, i) =>
    i === 0 ? leadTimes.length : leadTimes.filter((v) => v > PACE_BUCKETS[i - 1]).length,
  );
}

/** Bucket-to-bucket differences of the pace matrix — demand picked up within
 *  each DBA window. */
export function buildPickup(pace: number[]): number[] {
  return pace.map((v, i) => v - (pace[i + 1] ?? 0));
}

export function scoreOf(raw: number): SalesScore {
  if (raw >= 0.4) return "high_demand";
  if (raw >= 0.15) return "steady_sales";
  if (raw >= -0.1) return "slow_sales";
  return "needs_attention";
}

const daysBetween = (fromISO: string, toISO: string): number =>
  Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);

/** Full pace/pickup comparison for one stay date. `leadTimes` are the active
 *  (non-cancelled) per-night lead times for the date; `leadTimesLy` the same
 *  for the aligned date last year, pre-trimmed to bookings made by the aligned
 *  as-of date so both years are seen at the same DBA. */
export function paceSnapshot(
  date: string,
  asOf: string,
  leadTimes: number[],
  leadTimesLy: number[],
): PaceSnapshot {
  const dba = daysBetween(asOf, date);
  let bucketIndex = PACE_BUCKETS.findIndex((b) => b >= dba);
  if (bucketIndex === -1) bucketIndex = PACE_BUCKETS.length - 1;

  const paceMatrix = buildPace(leadTimes);
  const paceMatrixLy = buildPace(leadTimesLy);
  const pickupMatrix = buildPickup(paceMatrix);
  const pickupMatrixLy = buildPickup(paceMatrixLy);

  const paceCur = paceMatrix[bucketIndex];
  const paceLy = paceMatrixLy[bucketIndex];
  const pickupCur = pickupMatrix[bucketIndex];
  const pickupLy = pickupMatrixLy[bucketIndex];
  const [wPace, wPickup] = BUCKET_WEIGHTS[bucketIndex];

  const scoreRaw =
    wPace * Math.log((paceCur + 1) / (paceLy + 1)) + wPickup * Math.log((pickupCur + 1) / (pickupLy + 1));

  return {
    date,
    dba,
    bucketIndex,
    paceMatrix,
    pickupMatrix,
    paceMatrixLy,
    pickupMatrixLy,
    paceCur,
    paceLy,
    pickupCur,
    pickupLy,
    salesAbs: paceCur - paceLy,
    wPace,
    wPickup,
    scoreRaw: Math.round(scoreRaw * 10000) / 10000,
    score: scoreOf(scoreRaw),
  };
}
