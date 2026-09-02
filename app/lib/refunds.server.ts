// Issue a refund for a booking's charge and record it on the booking — Stripe
// or Viva, depending on which gateway took the payment. Guarded so it only ever
// refunds a real charge once; guarantee-card (setup) bookings have no charge to
// refund.
import { updateBooking, type BookingRecord } from "./bookings.server";
import { createRefund } from "./stripe.server";
import { fromStripeMinor } from "./money";
import { getVivaConfig } from "./overrides.server";
import { fromVivaMinor, toVivaMinor, vivaRefund } from "./viva.server";
import { claimRefund, releaseRefundClaim } from "./refund-claim.server";

export type RefundOutcome =
  | { ok: true; booking: BookingRecord; amount: number }
  | { ok: false; reason: "no_charge" | "already_refunded" | "error" };

/** Refund a booking's charge. Defaults to a full refund (`amountMinor`
 *  omitted). Idempotent per booking reference, and a no-op (not an error) for
 *  bookings that have no charge or were already refunded. Never throws — a
 *  failed refund is logged so the operator can retry/handle it manually. */
export async function refundBookingCharge(
  pid: string,
  booking: BookingRecord,
  opts: { amountMinor?: number; by?: string } = {},
): Promise<RefundOutcome> {
  const p = booking.payment;
  if (!p || p.mode !== "payment") return { ok: false, reason: "no_charge" };
  if (p.refund) return { ok: false, reason: "already_refunded" };
  if (p.provider === "viva" && !p.transactionId) return { ok: false, reason: "no_charge" };
  if (p.provider !== "viva" && (!p.paymentIntentId || !p.accountId)) return { ok: false, reason: "no_charge" };

  // The `p.refund` read above is not a fence: two concurrent cancels both see
  // "not refunded". This claim is — exactly one caller reaches the gateway.
  // Stripe would also dedupe on its idempotency key; Viva has none, and a
  // second DELETE /transactions/{tx} there is a second refund.
  const claimKey = `booking:${pid}:${booking.id}`;
  if (!(await claimRefund(claimKey))) return { ok: false, reason: "already_refunded" };

  let refund: { id: string; amount: number; currency?: string };
  if (p.provider === "viva") {
    const viva = await getVivaConfig(pid);
    if (!viva) {
      console.log(`[refund] viva credentials missing for pid=${pid} booking=${booking.reference}`);
      await releaseRefundClaim(claimKey);
      return { ok: false, reason: "error" };
    }
    try {
      const amountMinor = opts.amountMinor ?? toVivaMinor(p.amount ?? 0);
      const r = await vivaRefund(viva, p.transactionId!, amountMinor);
      refund = {
        id: r.TransactionId ?? p.transactionId!,
        amount: r.Amount ?? fromVivaMinor(amountMinor),
        currency: p.currency,
      };
    } catch (e) {
      console.log(`[refund] failed for booking=${booking.reference} viva tx=${p.transactionId}: ${e instanceof Error ? e.message : e}`);
      // Nothing left the account: hand the claim back so a retry can try again.
      await releaseRefundClaim(claimKey);
      return { ok: false, reason: "error" };
    }
  } else {
    try {
      const r = await createRefund(p.accountId!, p.paymentIntentId!, opts.amountMinor, `refund_${booking.reference}`);
      const refundCurrency = r.currency?.toUpperCase() || p.currency || "";
      // Stripe reports the refund in minor units; the fallback is already major.
      refund = {
        id: r.id,
        amount: r.amount != null ? fromStripeMinor(r.amount, refundCurrency) : (p.amount ?? 0),
        currency: r.currency?.toUpperCase() ?? p.currency,
      };
    } catch (e) {
      console.log(`[refund] failed for booking=${booking.reference} pi=${p.paymentIntentId}: ${e instanceof Error ? e.message : e}`);
      await releaseRefundClaim(claimKey);
      return { ok: false, reason: "error" };
    }
  }

  const updated = await updateBooking(pid, booking.id, {
    payment: {
      ...p,
      refund: { ...refund, at: new Date().toISOString(), by: opts.by },
    },
  });
  return { ok: true, booking: updated ?? booking, amount: refund.amount };
}
