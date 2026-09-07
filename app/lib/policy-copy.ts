// Client-safe helpers that turn a structured RatePolicy into guest-facing
// numbers + i18n descriptors: the checkout "due now vs at hotel" split, and
// short policy lines for the rate card / checkout. The cancellation free-until
// line reuses the existing cancellation engine (translated keys).
import { type CancelAnchor, resolveBands, tierHours } from "./cancel-bands";
import type { CancellationLike } from "./cancellation";
import type { RatePolicy } from "./rate-policy";

// Both used to live here; they moved with the band logic. Re-exported so the
// call sites that import them from this module keep working.
export { tierHours };
export type { CancelAnchor };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Represent the policy's cancellation schedule as a CancellationLike, so the
 *  existing cancellationMessage()/cancellationView() can render the free-until
 *  line with its already-translated keys — and the band lines after it.
 *
 *  `cancelByISO` is the end of the free window (the first tier's deadline);
 *  `bands` is the whole schedule. No stay amounts here: this is the checkout
 *  preview, and percentages read fine without them. */
export function policyToCancellation(
  p: RatePolicy,
  checkinISO?: string,
  anchor?: CancelAnchor,
): CancellationLike {
  if (!p.cancellation.refundable) return { refundable: false, cancelByISO: null };
  const tiers = p.cancellation.tiers;
  if (tiers.length === 0 || !checkinISO) return { refundable: true, cancelByISO: null };
  // Anchored to the hotel's wall clock on the arrival date, not to midnight UTC —
  // see cancelDeadline(). The naive local string rides along so what the guest
  // reads is the hotel's own 6pm rather than its UTC equivalent.
  const bands = resolveBands(tiers, checkinISO, anchor);
  if (!bands || bands.length === 0) return { refundable: true, cancelByISO: null };
  return {
    refundable: true,
    cancelByISO: bands[0].untilISO,
    cancelByLocal: bands[0].untilLocal,
    bands,
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
