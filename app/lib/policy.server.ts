import { bandAt, isPartialBand, mergeTiers, penaltyAmount, resolveBands } from "./cancel-bands";
import type { CancelBand } from "./cancellation";
import { getRates } from "./catalog.server";
import { getSettings } from "./overrides.server";
import { DEFAULT_RATE_POLICY, ratePolicyOf, type CancelTier, type PenaltyType, type RatePolicy } from "./rate-policy";

type Settings = Awaited<ReturnType<typeof getSettings>>;

export interface CancellationSnapshot {
  refundable: boolean;
  /** Latest moment a guest may cancel free (ISO). null = no time limit. */
  cancelByISO: string | null;
  /** The same moment as the hotel's wall clock, for display. See
   *  CancellationLike.cancelByLocal. */
  cancelByLocal?: string;
  /** The whole schedule when the rate has one — free band first, each later
   *  band with its penalty in major units against this stay's total, the last
   *  running to arrival. Absent on bookings made before multi-tier shipped and
   *  on rates with no deadline at all. See docs/cancellation-tiers.md §3.1. */
  bands?: CancelBand[];
}

/**
 * The tiers a rate actually runs on. A rate with none falls back to the
 * property-wide default window (Customer Portal settings), as the flat fields
 * always did — a structured policy with an empty `tiers` has never meant "free
 * any time" in practice, and changing that would silently loosen every rate
 * that never set a deadline. 0 is a real deadline here (the anchor time on
 * arrival day), not "unset".
 */
function effectiveTiers(policy: RatePolicy, settings: Settings): CancelTier[] {
  if (policy.cancellation.tiers.length > 0) return policy.cancellation.tiers;
  const v = settings.cancelDeadlineValue;
  if (v == null || !Number.isFinite(v) || v < 0) return [];
  return [{ deadlineValue: v, deadlineUnit: settings.cancelDeadlineUnit ?? "hours", penalty: "full_stay" }];
}

/**
 * Resolve a booking's cancellation schedule from its rates' policies and
 * snapshot it — instants and amounts, so later edits to the rate never change
 * what this guest was promised.
 *
 * Several rates merge to the harshest penalty at every moment (cancel-bands
 * `mergeTiers`); refundable only if every rate is. With `stay` known each band
 * carries its penalty in money, which is what the refund path pays against.
 */
export async function resolveBookingCancellation(
  pid: string,
  rateIds: string[],
  checkinISO: string,
  stay?: { total: number; nights: number },
): Promise<CancellationSnapshot> {
  const [rates, settings] = await Promise.all([getRates(pid), getSettings(pid)]);
  const byId = new Map(rates.map((r) => [r.id, r]));
  const anchor = { time: settings.cancelAnchorTime, timezone: settings.timezone };

  let refundable = true;
  const schedules: CancelTier[][] = [];
  for (const id of rateIds) {
    const rate = byId.get(id);
    if (!rate) continue;
    const policy = ratePolicyOf(rate);
    if (!policy.cancellation.refundable) refundable = false;
    schedules.push(effectiveTiers(policy, settings));
  }

  // Counted back from the hotel's cut-off time on the arrival date, in its own
  // timezone — so "24 hours" is 6pm the night before, and 0 is 6pm on the day.
  const merged = mergeTiers(schedules, stay ? (p, v) => penaltyAmount(p, v, stay) : undefined);
  const bands = (merged.length ? resolveBands(merged, checkinISO, anchor, stay) : []) ?? [];
  const cancelByISO = bands[0]?.untilISO ?? null;
  const cancelByLocal = bands[0]?.untilLocal;

  if (!refundable) return { refundable: false, cancelByISO, cancelByLocal };

  // A free-cancellation window that already closed before the booking was made
  // is, for THIS booking, non-refundable — the guest can never use it. Snapshot
  // it that way, or the confirmation email would promise "free cancellation
  // until <a past date>" (checkout already showed — and the guest acknowledged —
  // non-refundable). Unless the schedule still has a paying band open: then the
  // booking is "cancel by X for a partial refund", and that is what it keeps.
  if (cancelByISO && Date.parse(cancelByISO) <= Date.now() && !isPartialBand(bandAt(bands, Date.now()))) {
    return { refundable: false, cancelByISO: null };
  }
  return { refundable: true, cancelByISO, cancelByLocal, ...(bands.length ? { bands } : {}) };
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
 *  Multiple → a most-restrictive combine: strictest payment timing/card/no-show,
 *  refundable only if all are, and the cancellation schedule that charges the
 *  most at every moment (cancel-bands `mergeTiers`). */
export async function resolveBookingPolicy(pid: string, rateIds: string[]): Promise<RatePolicy> {
  const rates = await getRates(pid);
  const byId = new Map(rates.map((r) => [r.id, r]));
  const pols = rateIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ratePolicyOf(r));
  if (pols.length === 0) return DEFAULT_RATE_POLICY;
  if (pols.length === 1) return pols[0];

  const tiers = mergeTiers(pols.map((p) => p.cancellation.tiers));
  return pols.reduce((acc, p) => {
    const stricterTiming = TIMING_ORD[p.payment.timing] > TIMING_ORD[acc.payment.timing] ? p.payment : acc.payment;
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
