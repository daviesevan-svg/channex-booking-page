// Client-safe helpers that turn a structured RatePolicy into guest-facing
// numbers + i18n descriptors: the checkout "due now vs at hotel" split, and
// short policy lines for the rate card / checkout. The cancellation free-until
// line reuses the existing cancellation engine (translated keys).
import type { CancellationLike } from "./cancellation";
import { cancelDeadline } from "./dates";
import type { CancelTier, PenaltyType, RatePolicy } from "./rate-policy";

const round2 = (n: number) => Math.round(n * 100) / 100;

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
export function tierHours(tier: CancelTier): number {
  return tier.deadlineUnit === "days" ? tier.deadlineValue * 24 : tier.deadlineValue;
}

/** Represent the policy's first cancellation tier as a CancellationLike, so the
 *  existing cancellationMessage()/cancellationView() can render the free-until
 *  line with its already-translated keys. */
export function policyToCancellation(
  p: RatePolicy,
  checkinISO?: string,
  anchor?: CancelAnchor,
): CancellationLike {
  if (!p.cancellation.refundable) return { refundable: false, cancelByISO: null };
  const tier = p.cancellation.tiers[0];
  if (!tier || !checkinISO) return { refundable: true, cancelByISO: null };
  // Anchored to the hotel's wall clock on the arrival date, not to midnight UTC —
  // see cancelDeadline(). The naive local string rides along so what the guest
  // reads is the hotel's own 6pm rather than its UTC equivalent.
  const d = cancelDeadline(checkinISO, tierHours(tier), anchor?.time, anchor?.timezone);
  if (!d) return { refundable: true, cancelByISO: null };
  return {
    refundable: true,
    cancelByISO: new Date(d.utcMs).toISOString(),
    cancelByLocal: d.local,
  };
}

/** Amount due at booking time (0 = nothing today / pay at hotel). Clamped to the
 *  stay total. first night / first N nights are pro-rated from the room total. */
export function dueNow(p: RatePolicy, total: number, nights: number): number {
  const perNight = nights > 0 ? total / nights : total;
  if (p.payment.timing === "full_prepay") return round2(total);
  if (p.payment.timing === "deposit" && p.payment.deposit) {
    const d = p.payment.deposit;
    const amt =
      d.type === "percent"
        ? (total * d.value) / 100
        : d.type === "fixed"
          ? d.value
          : d.type === "first_night"
            ? perNight
            : perNight * Math.min(d.value, Math.max(1, nights)); // first_n_nights
    return Math.min(round2(amt), round2(total));
  }
  return 0; // pay_at_hotel
}

/** i18n key (+ params) describing a penalty amount, e.g. "{n}% of the stay". */
export type PenaltyMsg = { key: string; params?: Record<string, string | number> };

export function penaltyMsg(penalty: PenaltyType, value?: number): PenaltyMsg | null {
  switch (penalty) {
    case "none":
      return { key: "penaltyNone" };
    case "first_night":
      return { key: "penaltyFirstNight" };
    case "full_stay":
      return { key: "penaltyFullStay" };
    case "percent":
      return value ? { key: "penaltyPercent", params: { n: value } } : null;
    case "fixed":
      return value ? { key: "penaltyFixedAmount" } : null; // amount formatted by the caller
    default:
      return null;
  }
}
