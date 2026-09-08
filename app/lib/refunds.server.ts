// Issue a refund for a booking's charge and record it on the booking — Stripe,
// Viva or iyzico, depending on which gateway took the payment (2C2P: refused,
// see below). Guarded so it only ever
// refunds a real charge once; guarantee-card (setup) bookings have no charge to
// refund.
//
// All of the charge, or `amount` of it. A cancellation inside a paying band of
// a multi-step policy owes part of the money back (docs/cancellation-tiers.md
// §3.2), and the admin may refund a chosen amount. Either way it is ONE refund
// per booking: `payment.refund` is a single slot and the claim below is one key.
import { updateBooking, type BookingRecord } from "./bookings.server";
import { createRefund } from "./stripe.server";
import { fromStripeMinor, toStripeMinor } from "./money";
import { getVivaConfig } from "./overrides.server";
import { fromVivaMinor, toVivaMinor, vivaRefund } from "./viva.server";
import { claimRefund, releaseRefundClaim } from "./refund-claim.server";

export type RefundOutcome =
  | { ok: true; booking: BookingRecord; amount: number }
  | { ok: false; reason: "no_charge" | "already_refunded" | "invalid_amount" | "unsupported" | "error" };

/** Refund a booking's charge. `amount` (MAJOR units, the booking's currency)
 *  refunds that much of it; omitted = the whole charge. Idempotent per booking
 *  reference, and a no-op (not an error) for bookings that have no charge or
 *  were already refunded. Never throws — a failed refund is logged so the
 *  operator can retry/handle it manually. */
export async function refundBookingCharge(
  pid: string,
  booking: BookingRecord,
  opts: { amount?: number; by?: string } = {},
): Promise<RefundOutcome> {
  const p = booking.payment;
  if (!p || p.mode !== "payment") return { ok: false, reason: "no_charge" };
  if (p.refund) return { ok: false, reason: "already_refunded" };
  // 2C2P refunds live behind a separate API with its own RSA key exchange
  // (see 2c2p.server.ts). Until that is wired, the hotel refunds in the 2C2P
  // merchant portal — and every caller (guest self-cancel with autoRefund, the
  // admin button) already treats a not-ok outcome as "the hotel handles it".
  if (p.provider === "2c2p") return { ok: false, reason: "unsupported" };
  if (p.provider === "viva" && !p.transactionId) return { ok: false, reason: "no_charge" };
  if (p.provider !== "viva" && (!p.paymentIntentId || !p.accountId)) return { ok: false, reason: "no_charge" };

  const charged = p.amount ?? 0;
  const currency = p.currency || booking.currency;
  // Checked before the claim is taken: a refused amount must leave the claim
  // for a corrected retry.
  if (opts.amount != null && !(Number.isFinite(opts.amount) && opts.amount > 0 && opts.amount <= charged + 1e-9)) {
    return { ok: false, reason: "invalid_amount" };
  }
  // Only an amount genuinely below the charge is a partial; "refund all of it"
  // spelled as a number takes the full-refund path, exactly as no amount does.
  const partial = opts.amount != null && opts.amount < charged - 1e-9 ? opts.amount : undefined;

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
      // Viva's minor unit is always ×100 (its currencies are all two-decimal).
      const amountMinor = toVivaMinor(partial ?? charged);
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
      // Stripe's smallest unit is per currency and NOT the display decimals —
      // toStripeMinor, never `× 100` (JPY, UGX, ISK). A partial rides in the
      // idempotency key too: the same key with a different amount is a Stripe
      // 400, and a retry after a failed call may legitimately be for a later,
      // smaller band.
      const amountMinor = partial != null ? toStripeMinor(partial, currency) : undefined;
      const key = amountMinor != null ? `refund_${booking.reference}_${amountMinor}` : `refund_${booking.reference}`;
      const r = await createRefund(p.accountId!, p.paymentIntentId!, amountMinor, key);
      const refundCurrency = r.currency?.toUpperCase() || p.currency || "";
      // Stripe reports the refund in minor units; the fallback is already major.
      refund = {
        id: r.id,
        amount: r.amount != null ? fromStripeMinor(r.amount, refundCurrency) : (partial ?? charged),
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
