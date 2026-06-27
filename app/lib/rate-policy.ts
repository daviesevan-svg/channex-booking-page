// Client-safe rate-plan policy: payment/prepayment rules, cancellation (as an
// ordered array of free→penalty windows), and no-show. Pure types + a
// normalizer that builds the effective policy from either the structured
// `rate.policy` or the legacy flat fields, so old KV data keeps working.
//
// NOTE: there is no payment gateway — these rules drive the displayed breakdown,
// the guest-facing copy and the booking snapshot, not real card charging.
import type { DeadlineUnit } from "./content";

export type PaymentTiming = "pay_at_hotel" | "deposit" | "full_prepay";
export type CardHandling = "guarantee" | "charge_at_booking";
export type DepositType = "percent" | "fixed" | "first_night" | "first_n_nights";
/** What's charged as a cancellation/no-show penalty. */
export type PenaltyType = "none" | "first_night" | "percent" | "fixed" | "full_stay";

export interface DepositRule {
  type: DepositType;
  /** percent 0–100, a fixed amount in property currency, or a number of nights. */
  value: number;
}

export interface PaymentPolicy {
  timing: PaymentTiming;
  card: CardHandling;
  /** Only meaningful when timing === "deposit". */
  deposit?: DepositRule;
  // chargeSchedule (at booking / N days before / on arrival) is a phase-2 nicety;
  // for now everything is implicitly "at booking".
}

export interface CancelTier {
  /** Free to cancel until this far before arrival; after it, `penalty` applies. */
  deadlineValue: number;
  deadlineUnit: DeadlineUnit;
  penalty: PenaltyType;
  /** Percent (0–100) or fixed amount, for penalty = percent / fixed. */
  penaltyValue?: number;
}

export interface CancellationRules {
  refundable: boolean;
  /** Ordered free→penalty windows (most generous first). The admin UI ships a
   *  single tier; the array is here so multi-tier can land without a migration. */
  tiers: CancelTier[];
}

export interface NoShowRule {
  penalty: PenaltyType;
  penaltyValue?: number;
}

export interface RatePolicy {
  payment: PaymentPolicy;
  cancellation: CancellationRules;
  noShow: NoShowRule;
  /** Optional copy that replaces the auto-generated guest summary. */
  overrideNote?: string;
}

export const PAYMENT_TIMING_LABEL: Record<PaymentTiming, string> = {
  pay_at_hotel: "Pay at hotel",
  deposit: "Deposit",
  full_prepay: "Full prepayment",
};
export const CARD_HANDLING_LABEL: Record<CardHandling, string> = {
  guarantee: "Guarantee only (not charged)",
  charge_at_booking: "Charge at booking",
};
export const DEPOSIT_TYPE_LABEL: Record<DepositType, string> = {
  percent: "Percentage",
  fixed: "Fixed amount",
  first_night: "First night",
  first_n_nights: "First N nights",
};
export const PENALTY_LABEL: Record<PenaltyType, string> = {
  none: "No charge",
  first_night: "First night",
  percent: "Percentage of stay",
  fixed: "Fixed amount",
  full_stay: "Full stay",
};

export const PAYMENT_TIMINGS = Object.keys(PAYMENT_TIMING_LABEL) as PaymentTiming[];
export const CARD_HANDLINGS = Object.keys(CARD_HANDLING_LABEL) as CardHandling[];
export const DEPOSIT_TYPES = Object.keys(DEPOSIT_TYPE_LABEL) as DepositType[];
export const PENALTY_TYPES = Object.keys(PENALTY_LABEL) as PenaltyType[];

export const DEFAULT_RATE_POLICY: RatePolicy = {
  payment: { timing: "pay_at_hotel", card: "guarantee" },
  cancellation: { refundable: true, tiers: [] },
  noShow: { penalty: "first_night" },
};

/** Legacy flat policy fields carried on a rate before this model existed. */
export interface LegacyPolicyFields {
  policy?: RatePolicy;
  refundable?: boolean;
  cancelDeadlineValue?: number;
  cancelDeadlineUnit?: DeadlineUnit;
  cancellationNote?: string;
}

function isPenalty(v: unknown): v is PenaltyType {
  return typeof v === "string" && (PENALTY_TYPES as string[]).includes(v);
}

/** Fill a (possibly partial) stored policy with defaults. */
function withDefaults(p: RatePolicy): RatePolicy {
  return {
    payment: {
      timing: p.payment?.timing ?? "pay_at_hotel",
      card: p.payment?.card ?? "guarantee",
      deposit: p.payment?.deposit,
    },
    cancellation: {
      refundable: p.cancellation?.refundable !== false,
      tiers: Array.isArray(p.cancellation?.tiers) ? p.cancellation.tiers : [],
    },
    noShow: { penalty: isPenalty(p.noShow?.penalty) ? p.noShow.penalty : "first_night", penaltyValue: p.noShow?.penaltyValue },
    overrideNote: p.overrideNote,
  };
}

/** The effective policy for a rate — from the structured `policy` if present,
 *  else reconstructed from the legacy flat fields (no KV migration needed). */
export function ratePolicyOf(rate: LegacyPolicyFields): RatePolicy {
  if (rate.policy) return withDefaults(rate.policy);

  const refundable = rate.refundable !== false;
  const hasDeadline = !!rate.cancelDeadlineValue && rate.cancelDeadlineValue > 0;
  // Legacy: free until the deadline, then a full charge; non-refundable = no free window.
  const tiers: CancelTier[] =
    refundable && hasDeadline
      ? [
          {
            deadlineValue: rate.cancelDeadlineValue!,
            deadlineUnit: rate.cancelDeadlineUnit ?? "hours",
            penalty: "full_stay",
          },
        ]
      : [];
  return {
    payment: { timing: "pay_at_hotel", card: "guarantee" },
    cancellation: { refundable, tiers },
    noShow: { penalty: "first_night" },
    overrideNote: rate.cancellationNote,
  };
}
