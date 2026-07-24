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
