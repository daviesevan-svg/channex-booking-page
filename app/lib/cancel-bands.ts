// A cancellation policy with more than one step, as the guest experiences it:
// free until a moment, a charge until a later moment, a bigger charge after.
//
// The rate stores this as `tiers` — offsets before arrival — and every consumer
// used to read only the first one. This module turns the whole array into
// `CancelBand`s: absolute instants, most generous first, the last running to
// arrival. A booking snapshots its bands at creation (docs/cancellation-tiers.md
// §3.1), so nothing downstream ever re-derives a deadline or a percentage from
// the rate as it is later edited.
//
// Client-safe and pure. The anchor (the hotel's cut-off time and timezone) is
// passed in, exactly as policy-copy does.
import type { CancelBand } from "./cancellation";
import { cancelDeadline } from "./dates";
import type { DeadlineUnit } from "./content";
import type { CancelTier, PenaltyType } from "./rate-policy";

/** How the hotel's clock is set, for turning a tier into a real moment. Passed in
 *  rather than read here so this file stays pure and client-safe. */
export interface CancelAnchor {
  /** "HH:MM" on the arrival date that the deadline counts back from. */
  time?: string;
  /** IANA timezone the wall-clock is read in. */
  timezone?: string;
}

/** A tier's window in hours. `deadlineValue` may legitimately be 0 — that's the
 *  anchor time itself (6pm on the day of arrival). */
export function tierHours(tier: Pick<CancelTier, "deadlineValue" | "deadlineUnit">): number {
  return tier.deadlineUnit === "days" ? tier.deadlineValue * 24 : tier.deadlineValue;
}

/** What a cancellation costs, in major units against the stay total. Fixed
 *  amounts are taken as stated; `first_night` is the stay pro-rated. */
export function penaltyAmount(
  penalty: PenaltyType,
  value: number | undefined,
  stay: { total: number; nights: number },
): number {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  switch (penalty) {
    case "none":
      return 0;
    case "full_stay":
      return round2(stay.total);
    case "percent":
      return round2((stay.total * (value ?? 0)) / 100);
    case "fixed":
      return round2(Math.min(value ?? 0, stay.total));
    case "first_night":
      return round2(stay.nights > 0 ? stay.total / stay.nights : stay.total);
  }
}

/**
 * The tiers as bands, resolved against a check-in date.
 *
 * `tiers[i]` reads "free until this deadline; after it, this penalty" — so N
 * tiers make N+1 bands: the free one, then each tier's penalty running until
 * the next tier's deadline, the last to arrival (`untilISO: null`).
 *
 * Null when the check-in date is unusable. An empty `tiers` is not this
 * function's call — the caller decides whether that means "free any time" or
 * "use the property default".
 */
export function resolveBands(
  tiers: CancelTier[],
  checkinISO: string,
  anchor?: CancelAnchor,
  stay?: { total: number; nights: number },
): CancelBand[] | null {
  if (tiers.length === 0) return [];
  const deadlines = tiers.map((t) => cancelDeadline(checkinISO, tierHours(t), anchor?.time, anchor?.timezone));
  if (deadlines.some((d) => d === null)) return null;
  const at = (i: number) => {
    const d = deadlines[i]!;
    return { untilISO: new Date(d.utcMs).toISOString(), untilLocal: d.local };
  };
  const bands: CancelBand[] = [{ ...at(0), penalty: "none", ...(stay ? { penaltyAmount: 0 } : {}) }];
  tiers.forEach((t, i) => {
    const next = i + 1 < tiers.length ? at(i + 1) : { untilISO: null, untilLocal: undefined };
    bands.push({
      untilISO: next.untilISO,
      untilLocal: next.untilLocal,
      penalty: t.penalty,
      penaltyValue: t.penaltyValue,
      ...(stay ? { penaltyAmount: penaltyAmount(t.penalty, t.penaltyValue, stay) } : {}),
    });
  });
  return bands;
}

/** The band a cancellation at `nowMs` falls in. A cancellation AT the boundary
 *  is inside the band (`now <= until`) — one rule for the gate, the copy and
 *  the tests. Undefined only for an empty schedule. */
export function bandAt(bands: CancelBand[], nowMs: number): CancelBand | undefined {
  return bands.find((b) => b.untilISO === null || nowMs <= Date.parse(b.untilISO));
}

/** Money owed back if the guest cancels in `band`, out of what was charged.
 *  Penalties are stated against the stay total, so a deposit smaller than the
 *  penalty refunds nothing. Without a known amount the answer is conservative:
 *  everything for a free band, nothing otherwise. */
export function bandRefund(band: CancelBand, charged: number): number {
  const penalty = band.penaltyAmount ?? (band.penalty === "none" ? 0 : charged);
  return Math.max(0, Math.min(charged, Math.round((charged - penalty) * 100) / 100));
}

/** Is this a band with something to refund but not everything — the reason
 *  multi-tier exists. */
export function isPartialBand(band: CancelBand | undefined): band is CancelBand {
  return !!band && band.penalty !== "none" && band.penalty !== "full_stay" && !(band.penalty === "percent" && (band.penaltyValue ?? 0) >= 100);
}

// ---- merging (mixed carts) ----

/** Harshness without knowing the stay: none < first night < percent (by value)
 *  < fixed < full stay. A fixed fee and a percentage aren't truly comparable
 *  without amounts; callers that know the stay pass `amountOf` instead. */
function rank(penalty: PenaltyType, value?: number): number {
  switch (penalty) {
    case "none":
      return 0;
    case "first_night":
      return 1;
    case "percent":
      return 2 + Math.min(value ?? 0, 100) / 100;
    case "fixed":
      return 3.5;
    case "full_stay":
      return 4;
  }
}

interface Step {
  hours: number;
  penalty: PenaltyType;
  penaltyValue?: number;
}

/**
 * One schedule for a cart of several rates: at every moment, the harshest
 * penalty any rate applies. Conservative and honest — the guest is promised no
 * more than the strictest room allows, and the snapshot holds a single schedule.
 *
 * Boundaries are the union of every rate's deadlines; between them the harshest
 * penalty wins; equal neighbours collapse. Output is in hours, or days when
 * every boundary divides by 24 (so the copy reads "14 days", not "336 hours").
 */
export function mergeTiers(
  schedules: CancelTier[][],
  amountOf?: (penalty: PenaltyType, value?: number) => number,
): CancelTier[] {
  const live = schedules.filter((s) => s.length > 0);
  if (live.length === 0) return [];
  if (live.length === 1) return live[0];

  const harsher = (a: Step, b: Step): Step => {
    const ka = amountOf ? amountOf(a.penalty, a.penaltyValue) : rank(a.penalty, a.penaltyValue);
    const kb = amountOf ? amountOf(b.penalty, b.penaltyValue) : rank(b.penalty, b.penaltyValue);
    return kb > ka ? b : a;
  };
  // What a schedule charges `h` hours before arrival: the penalty of the last
  // tier whose deadline is at or above h — none above the first.
  const penaltyAt = (tiers: CancelTier[], h: number): Step => {
    let step: Step = { hours: h, penalty: "none" };
    for (const t of tiers) {
      if (tierHours(t) > h) step = { hours: h, penalty: t.penalty, penaltyValue: t.penaltyValue };
    }
    return step;
  };

  const boundaries = [...new Set(live.flatMap((s) => s.map(tierHours)))].sort((a, b) => b - a);
  // Sample just below each boundary: that is the interval the boundary opens.
  const steps = boundaries.map((h) => {
    const probe = h - 1e-6;
    return live.map((s) => penaltyAt(s, probe)).reduce(harsher);
  });

  const out: CancelTier[] = [];
  let last: Step | undefined;
  boundaries.forEach((h, i) => {
    const s = steps[i];
    if (last && last.penalty === s.penalty && last.penaltyValue === s.penaltyValue) return;
    // A tier is "free until, then X": the first emitted must therefore be the
    // moment charging starts, which is the first boundary whose interval charges.
    if (!last && s.penalty === "none") return;
    out.push({ deadlineValue: h, deadlineUnit: "hours", penalty: s.penalty, penaltyValue: s.penaltyValue });
    last = s;
  });

  if (out.every((t) => t.deadlineValue % 24 === 0)) {
    return out.map((t) => ({ ...t, deadlineValue: t.deadlineValue / 24, deadlineUnit: "days" as DeadlineUnit }));
  }
  return out;
}

// ---- validation ----

/** Enough for any hotel policy, and the rate editor has to draw it. */
export const MAX_CANCEL_TIERS = 4;

/**
 * The shape the rest of this module relies on: deadlines strictly closer to
 * arrival along the array, each band at least as harsh as the one before, and
 * values where the penalty type needs them. Returns the first problem in words,
 * or null. Shared by the rate editor and the management API.
 */
export function validateTiers(tiers: CancelTier[]): string | null {
  if (tiers.length > MAX_CANCEL_TIERS) return `At most ${MAX_CANCEL_TIERS} cancellation tiers.`;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (!Number.isInteger(t.deadlineValue) || t.deadlineValue < 0) return `Tier ${i + 1}: the deadline must be a whole number ≥ 0.`;
    // "Free until X, then no charge" is a deadline that does nothing. Alone it
    // is harmless (and existing rates have it); in a schedule it only pushes the
    // real steps out of line with what the guest reads.
    if (tiers.length > 1 && t.penalty === "none") return `Tier ${i + 1}: every tier of a multi-step policy must charge something.`;
    if (t.penalty === "percent") {
      if (t.penaltyValue == null || !(t.penaltyValue > 0) || t.penaltyValue > 100) return `Tier ${i + 1}: a percentage must be between 1 and 100.`;
    } else if (t.penalty === "fixed") {
      if (t.penaltyValue == null || !(t.penaltyValue > 0)) return `Tier ${i + 1}: a fixed charge needs an amount above 0.`;
    }
    if (i > 0) {
      const prev = tiers[i - 1];
      if (tierHours(t) >= tierHours(prev)) return `Tier ${i + 1} must be closer to arrival than tier ${i}.`;
      if (rank(t.penalty, t.penaltyValue) < rank(prev.penalty, prev.penaltyValue)) {
        return `Tier ${i + 1} can't charge less than tier ${i} — later cancellations cost more, not less.`;
      }
    }
  }
  return null;
}
