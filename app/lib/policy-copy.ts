// Client-safe helpers that turn a structured RatePolicy into guest-facing
// numbers + i18n descriptors: the checkout "due now vs at hotel" split, and
// short policy lines for the rate card / checkout. The cancellation free-until
// line reuses the existing cancellation engine (translated keys).
import type { CancellationLike } from "./cancellation";
import type { PenaltyType, RatePolicy } from "./rate-policy";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Represent the policy's first cancellation tier as a CancellationLike, so the
 *  existing cancellationMessage()/cancellationView() can render the free-until
 *  line with its already-translated keys. */
export function policyToCancellation(p: RatePolicy, checkinISO?: string): CancellationLike {
  if (!p.cancellation.refundable) return { refundable: false, cancelByISO: null };
  const tier = p.cancellation.tiers[0];
  if (!tier || !checkinISO) return { refundable: true, cancelByISO: null };
  const hours = tier.deadlineUnit === "days" ? tier.deadlineValue * 24 : tier.deadlineValue;
  const checkinMs = Date.parse(checkinISO);
  if (Number.isNaN(checkinMs)) return { refundable: true, cancelByISO: null };
  return { refundable: true, cancelByISO: new Date(checkinMs - hours * 3600 * 1000).toISOString() };
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
