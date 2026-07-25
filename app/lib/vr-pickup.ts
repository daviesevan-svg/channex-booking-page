// Competitor "pickup" inference — pure, client-safe. We snapshot each comp's
// availability for each stay-date over time (see vr-comp-capture). When a comp
// that WAS available for a date becomes unavailable, the most likely
// explanation is that someone booked it — so a run of available→closed
// transitions across the comp set is a demand signal for that date.
//
// This is deliberately a GUESS, not a booking ledger. A comp can also drop out
// of a dated Airbnb search because of a minimum-stay rule or the ~25-result
// cap/ranking churn, and can reappear (a cancellation, or ranking noise). So we
// only ever read the DELTA between snapshots, never the absolute state, and the
// caller surfaces it as "inferred", with confidence scaled by how many comps
// moved.

export interface AvailPoint {
  /** ISO timestamp of the capture. */
  capturedAt: string;
  available: boolean;
}

export interface SeriesAnalysis {
  current: "available" | "closed" | "unknown";
  /** The newest snapshot flipped available→closed vs the one before it. */
  recentlyBooked: boolean;
  /** The newest snapshot flipped closed→available (cancellation / reopened). */
  recentlyOpened: boolean;
  /** available→closed transitions across the whole series. */
  bookedTransitions: number;
  openedTransitions: number;
}

/** Analyse one comp's availability history for one stay-date. Points may be in
 *  any order and may repeat a state (we count changes, not samples). */
export function analyzeSeries(points: AvailPoint[]): SeriesAnalysis {
  if (points.length === 0) return { current: "unknown", recentlyBooked: false, recentlyOpened: false, bookedTransitions: 0, openedTransitions: 0 };
  const ordered = [...points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  let bookedTransitions = 0;
  let openedTransitions = 0;
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1].available;
    const cur = ordered[i].available;
    if (prev && !cur) bookedTransitions++;
    else if (!prev && cur) openedTransitions++;
  }
  const last = ordered[ordered.length - 1];
  const prev = ordered.length >= 2 ? ordered[ordered.length - 2] : undefined;
  return {
    current: last.available ? "available" : "closed",
    recentlyBooked: Boolean(prev && prev.available && !last.available),
    recentlyOpened: Boolean(prev && !prev.available && last.available),
    bookedTransitions,
    openedTransitions,
  };
}

/** Booking pace for one stay-date. Pace is the point of tracking availability:
 *  a rental host can't see competitors' bookings, but they CAN see how fast
 *  comparable places are filling, which is what tells them whether to hold or
 *  move price. */
export interface DatePace {
  date: string;
  /** Days before arrival, from the reference "today". */
  dba: number;
  /** Day of week, 0=Sunday — surfaced because weekend dates fill on a different
   *  curve to midweek, which the DBA cohort below can't separate. */
  dow: number;
  tracked: number;
  /** Share of tracked comps closed at the latest snapshot, 0..1. */
  occupancy: number | null;
  /** Comps booked per day across the observed snapshot window; null until we
   *  have at least two snapshots spanning a day. */
  velocity: number | null;
  /** Comps that flipped available→closed within the recent window. */
  pickupWindow: number | null;
  /** Typical occupancy of dates at a similar DBA across this property's tracked
   *  horizon — the market's own fill curve, so no prior-year data is needed.
   *  Null when too few comparable dates to be meaningful. */
  expectedOccupancy: number | null;
  /** occupancy / expectedOccupancy. >1 = filling faster than the market curve. */
  index: number | null;
  signal: "ahead" | "on_track" | "behind" | "unknown";
}

/** Cohort half-width in days when deriving the expected-occupancy curve. */
const DBA_WINDOW = 5;
/** Minimum comparable dates before an expected-occupancy figure is trustworthy. */
const MIN_COHORT = 4;
/** Index thresholds for the ahead/behind call. */
const AHEAD_AT = 1.15;
const BEHIND_AT = 0.85;

const dayMs = 86_400_000;

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Booking pace per date. `byDate` maps a stay-date to, per comp, that comp's
 *  availability history for the date (same shape as pickupByDate).
 *  `windowDays` bounds the "recent pickup" lookback. */
export function paceByDate(
  byDate: Map<string, AvailPoint[][]>,
  todayISO: string,
  windowDays = 7,
): DatePace[] {
  const todayMs = Date.parse(`${todayISO}T00:00:00Z`);
  const rows: DatePace[] = [];

  for (const [date, comps] of byDate) {
    let tracked = 0;
    let closedNow = 0;
    let closedAtStart = 0;
    let pickupWindow = 0;
    let earliest = Infinity;
    let latest = -Infinity;

    for (const series of comps) {
      if (series.length === 0) continue;
      const ordered = [...series].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      tracked++;
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      if (!last.available) closedNow++;
      if (!first.available) closedAtStart++;
      earliest = Math.min(earliest, Date.parse(first.capturedAt));
      latest = Math.max(latest, Date.parse(last.capturedAt));
      // Recent pickup: an available→closed step inside the window.
      const cutoff = Date.parse(last.capturedAt) - windowDays * dayMs;
      for (let i = 1; i < ordered.length; i++) {
        const t = Date.parse(ordered[i].capturedAt);
        if (t >= cutoff && ordered[i - 1].available && !ordered[i].available) {
          pickupWindow++;
          break; // count a comp once
        }
      }
    }

    const occupancy = tracked > 0 ? closedNow / tracked : null;
    const spanDays = Number.isFinite(earliest) && Number.isFinite(latest) ? (latest - earliest) / dayMs : 0;
    const velocity = tracked > 0 && spanDays >= 1 ? (closedNow - closedAtStart) / spanDays : null;
    const dba = Math.round((Date.parse(`${date}T00:00:00Z`) - todayMs) / dayMs);

    rows.push({
      date,
      dba,
      dow: new Date(`${date}T00:00:00Z`).getUTCDay(),
      tracked,
      occupancy: occupancy === null ? null : Math.round(occupancy * 100) / 100,
      velocity: velocity === null ? null : Math.round(velocity * 100) / 100,
      pickupWindow: tracked > 0 ? pickupWindow : null,
      expectedOccupancy: null,
      index: null,
      signal: "unknown",
    });
  }

  // Second pass: the market's own fill curve. For each date, "expected" is the
  // median occupancy of other tracked dates at a similar DBA — so a date is
  // judged against how far out it is, not against an absolute target.
  const withOcc = rows.filter((r) => r.occupancy !== null);
  for (const row of rows) {
    if (row.occupancy === null) continue;
    const cohort = withOcc.filter((o) => o.date !== row.date && Math.abs(o.dba - row.dba) <= DBA_WINDOW).map((o) => o.occupancy as number);
    if (cohort.length < MIN_COHORT) continue;
    const expected = medianOf(cohort);
    if (expected === null) continue;
    row.expectedOccupancy = Math.round(expected * 100) / 100;
    // An all-empty cohort can't be divided into; treat any occupancy above it as
    // ahead, and equal-and-zero as on track.
    if (expected === 0) {
      row.index = row.occupancy > 0 ? AHEAD_AT : 1;
    } else {
      row.index = Math.round((row.occupancy / expected) * 100) / 100;
    }
    row.signal = row.index >= AHEAD_AT ? "ahead" : row.index <= BEHIND_AT ? "behind" : "on_track";
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export interface DatePickup {
  date: string;
  /** Comps we have any snapshot for (the denominator). */
  tracked: number;
  /** Comps whose latest snapshot is available / closed. */
  availableNow: number;
  closedNow: number;
  /** Comps that flipped available→closed at the most recent capture — the
   *  freshest "just got booked" signal. */
  bookedRecent: number;
  openedRecent: number;
  /** How full the comp set is right now, 0..1 (closedNow / tracked). Null when
   *  nothing is tracked for the date. */
  occupancy: number | null;
}

/** Per-date pickup across the comp set. `byDate` maps a stay-date to, per comp,
 *  that comp's availability history for the date. */
export function pickupByDate(byDate: Map<string, AvailPoint[][]>): DatePickup[] {
  const out: DatePickup[] = [];
  for (const [date, comps] of byDate) {
    let availableNow = 0, closedNow = 0, bookedRecent = 0, openedRecent = 0, tracked = 0;
    for (const series of comps) {
      const a = analyzeSeries(series);
      if (a.current === "unknown") continue;
      tracked++;
      if (a.current === "available") availableNow++;
      else closedNow++;
      if (a.recentlyBooked) bookedRecent++;
      if (a.recentlyOpened) openedRecent++;
    }
    out.push({
      date,
      tracked,
      availableNow,
      closedNow,
      bookedRecent,
      openedRecent,
      occupancy: tracked > 0 ? Math.round((closedNow / tracked) * 100) / 100 : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
