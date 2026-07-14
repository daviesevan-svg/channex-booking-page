import { getRates } from "./catalog.server";
import type { DeadlineUnit } from "./content";
import { getSettings } from "./overrides.server";
import { DEFAULT_RATE_POLICY, ratePolicyOf, type PenaltyType, type RatePolicy } from "./rate-policy";

export interface CancellationSnapshot {
  refundable: boolean;
  /** Latest moment a guest may self-cancel (ISO). null = no time limit. */
  cancelByISO: string | null;
}

function deadlineMs(value?: number, unit?: DeadlineUnit): number | null {
  if (!value || value <= 0) return null;
  const hours = unit === "days" ? value * 24 : value; // default unit: hours
  return hours * 3600 * 1000;
}

/** Resolve a booking's cancellation policy from its rates' overrides, falling
 *  back to the global Customer Portal defaults. For multi-room bookings we take
 *  the most restrictive: refundable only if every rate is, and the earliest
 *  cancel-by deadline across rooms. */
export async function resolveBookingCancellation(
  pid: string,
  rateIds: string[],
  checkinISO: string,
): Promise<CancellationSnapshot> {
  const [rates, settings] = await Promise.all([getRates(pid), getSettings(pid)]);
  const byId = new Map(rates.map((r) => [r.id, r]));
  const checkinMs = Date.parse(checkinISO);

  let refundable = true;
  let earliestCancelBy: number | null = null;

  for (const id of rateIds) {
    const rate = byId.get(id);
    if (!rate) continue;
    if (rate.refundable === false) refundable = false;

    let value = rate.cancelDeadlineValue;
    let unit = rate.cancelDeadlineUnit;
    if (value == null) {
      value = settings.cancelDeadlineValue;
      unit = settings.cancelDeadlineUnit;
    }
    const ms = deadlineMs(value, unit);
    if (ms == null) continue; // this rate has no time limit
    const cancelBy = checkinMs - ms;
    earliestCancelBy = earliestCancelBy == null ? cancelBy : Math.min(earliestCancelBy, cancelBy);
  }

  const cancelByISO =
    earliestCancelBy == null || Number.isNaN(earliestCancelBy)
      ? null
      : new Date(earliestCancelBy).toISOString();
  // A free-cancellation window that already closed before the booking was made
  // is, for THIS booking, non-refundable — the guest can never use it. Snapshot
  // it that way, or the confirmation email would promise "free cancellation
  // until <a past date>" (checkout already showed — and the guest acknowledged —
  // non-refundable).
  if (refundable && earliestCancelBy != null && earliestCancelBy <= Date.now()) {
    return { refundable: false, cancelByISO: null };
  }
  return { refundable, cancelByISO };
}

/** True when the cart mixes refundable and non-refundable rates. A single
 *  cancellation line can't honestly describe that (the merged policy would call
 *  the whole booking non-refundable, hiding that one room is flexible), so the
 *  checkout shows a general "varies by room" note instead. */
export async function cancellationVaries(pid: string, rateIds: string[]): Promise<boolean> {
  const rates = await getRates(pid);
  const byId = new Map(rates.map((r) => [r.id, r]));
  let anyRefundable = false;
  let anyNonRefundable = false;
  for (const id of rateIds) {
    const rate = byId.get(id);
    if (!rate) continue;
    if (ratePolicyOf(rate).cancellation.refundable) anyRefundable = true;
    else anyNonRefundable = true;
  }
  return anyRefundable && anyNonRefundable;
}

const TIMING_ORD = { pay_at_hotel: 0, deposit: 1, full_prepay: 2 } as const;
const PENALTY_ORD: Record<PenaltyType, number> = { none: 0, first_night: 1, fixed: 2, percent: 2, full_stay: 3 };

/** The effective rate policy for a booking. Single rate → that rate's policy.
 *  Multiple → a best-effort most-restrictive combine (strictest payment timing/
 *  card/no-show, refundable only if all are, harshest first cancel tier). */
export async function resolveBookingPolicy(pid: string, rateIds: string[]): Promise<RatePolicy> {
  const rates = await getRates(pid);
  const byId = new Map(rates.map((r) => [r.id, r]));
  const pols = rateIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ratePolicyOf(r));
  if (pols.length === 0) return DEFAULT_RATE_POLICY;
  if (pols.length === 1) return pols[0];

  return pols.reduce((acc, p) => {
    const stricterTiming = TIMING_ORD[p.payment.timing] > TIMING_ORD[acc.payment.timing] ? p.payment : acc.payment;
    const accTier = acc.cancellation.tiers[0];
    const pTier = p.cancellation.tiers[0];
    const tierMs = (t?: { deadlineValue: number; deadlineUnit: DeadlineUnit }) =>
      t ? (t.deadlineUnit === "days" ? t.deadlineValue * 24 : t.deadlineValue) : -1;
    const tiers = tierMs(pTier) > tierMs(accTier) ? p.cancellation.tiers : acc.cancellation.tiers;
    return {
      payment: {
        timing: stricterTiming.timing,
        card: p.payment.card === "charge_at_booking" || acc.payment.card === "charge_at_booking" ? "charge_at_booking" : "guarantee",
        deposit: stricterTiming.deposit,
      },
      cancellation: { refundable: acc.cancellation.refundable && p.cancellation.refundable, tiers },
      noShow: PENALTY_ORD[p.noShow.penalty] > PENALTY_ORD[acc.noShow.penalty] ? p.noShow : acc.noShow,
      overrideNote: acc.overrideNote ?? p.overrideNote,
    };
  });
}
