// Issue a Stripe refund for a booking's charge and record it on the booking.
// Guarded so it only ever refunds a real charge once; guarantee-card (setup)
// bookings have no charge to refund.
import { updateBooking, type BookingRecord } from "./bookings.server";
import { createRefund } from "./stripe.server";

export type RefundOutcome =
  | { ok: true; booking: BookingRecord; amount: number }
  | { ok: false; reason: "no_charge" | "already_refunded" | "error" };

/** Refund a booking's Stripe charge. Defaults to a full refund (`amountMinor`
 *  omitted). Idempotent per booking reference, and a no-op (not an error) for
 *  bookings that have no charge or were already refunded. Never throws — a
 *  failed refund is logged so the operator can retry/handle it manually. */
export async function refundBookingCharge(
  pid: string,
  booking: BookingRecord,
  amountMinor?: number,
): Promise<RefundOutcome> {
  const p = booking.payment;
  if (!p || p.mode !== "payment" || !p.paymentIntentId || !p.accountId) {
    return { ok: false, reason: "no_charge" };
  }
  if (p.refund) return { ok: false, reason: "already_refunded" };

  try {
    const refund = await createRefund(p.accountId, p.paymentIntentId, amountMinor, `refund_${booking.reference}`);
    const amount = (refund.amount ?? Math.round((p.amount ?? 0) * 100)) / 100;
    const updated = await updateBooking(pid, booking.id, {
      payment: {
        ...p,
        refund: { id: refund.id, amount, currency: refund.currency?.toUpperCase() ?? p.currency, at: new Date().toISOString() },
      },
    });
    return { ok: true, booking: updated ?? booking, amount };
  } catch (e) {
    console.log(`[refund] failed for booking=${booking.reference} pi=${p.paymentIntentId}: ${e instanceof Error ? e.message : e}`);
    return { ok: false, reason: "error" };
  }
}
