// The post-payment half of a voucher purchase: issue the voucher (atomic,
// finalize-once) and send the emails. Shared by the direct test-mode path, the
// Stripe return URL, and the webhook backstop — mirrors booking-finalize.
import type { VoucherRecord } from "./vouchers";
import { claimVoucher } from "./vouchers.server";
import { deletePendingVoucher, getPendingVoucher, type PendingVoucher } from "./pending-vouchers.server";
import { paymentFromSession } from "./booking-finalize.server";
import { retrieveCheckoutSession } from "./stripe.server";
import { getOverrides, getSettings } from "./overrides.server";
import { sendEmail } from "./email.server";
import { accentHex, renderSimpleEmail } from "./email-render.server";
import { composeVoucherEmail } from "./voucher-email.server";
import { formatMoney } from "./money";
import type { PaymentInfo } from "./bookings.server";

/** Issue the voucher from a prepared pending purchase. Idempotent by (pid,
 *  code): the Stripe return URL and the webhook can both call this; the loser
 *  of the D1 claim returns the existing record and sends nothing twice. */
export async function finalizeVoucher(
  pending: PendingVoucher,
  payment: PaymentInfo | undefined,
): Promise<VoucherRecord> {
  const record: VoucherRecord = {
    ...pending.record,
    payment: payment
      ? {
          provider: payment.provider,
          accountId: payment.accountId,
          sessionId: payment.sessionId,
          paymentIntentId: payment.paymentIntentId,
          amount: payment.amount,
          currency: payment.currency,
        }
      : undefined,
    simulated: pending.live ? undefined : true,
  };
  const claim = await claimVoucher(pending.pid, record);
  if (!claim.won) return claim.existing ?? record;
  await sendVoucherEmails(pending.pid, record, pending.origin, pending.channel);
  return record;
}

/** Webhook backstop: look up the pending purchase, confirm the session paid,
 *  finalize. No-op when nothing is pending or the session isn't paid. */
export async function finalizeVoucherFromStripeSession(ref: string, sessionId: string): Promise<VoucherRecord | null> {
  const pending = await getPendingVoucher(ref);
  if (!pending) return null;
  const session = await retrieveCheckoutSession(pending.account, sessionId);
  const payment = paymentFromSession(pending.account, sessionId, session);
  if (!payment || payment.mode !== "payment") return null;
  const record = await finalizeVoucher(pending, payment);
  await deletePendingVoucher(ref);
  return record;
}

/** Purchase emails (fixed English copy v1, design-handoff layout): a receipt
 *  to the buyer, and — when bought as a gift with a recipient email — the
 *  voucher itself to the recipient with the buyer's message. When there's no
 *  recipient email the buyer's mail carries the code (they hand it over
 *  themselves). */
export async function sendVoucherEmails(
  pid: string,
  v: VoucherRecord,
  origin: string,
  channel: string,
): Promise<void> {
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid)]);
    const base = origin.replace(/\/+$/, "");
    const ctx = {
      v,
      hotelName: ov.hotelName || "Your hotel",
      accent: accentHex(settings),
      currency: settings.currency || "GBP",
      voucherUrl: `${base}/${channel}/voucher/${v.code}`,
      shopUrl: `${base}/${channel}/vouchers`,
    };

    // Buyer receipt.
    const receipt = composeVoucherEmail({ variant: "receipt", ...ctx });
    await sendEmail({
      to: v.buyer.email,
      subject: receipt.subject,
      html: receipt.html,
      replyTo: settings.emailReplyTo,
    });

    // Gift delivery to the recipient.
    if (v.gift?.recipientEmail) {
      const delivery = composeVoucherEmail({ variant: "gift", ...ctx });
      await sendEmail({
        to: v.gift.recipientEmail,
        subject: delivery.subject,
        html: delivery.html,
        replyTo: settings.emailReplyTo,
      });
    }
  } catch (e) {
    // Never fail an issued (paid) voucher over email delivery — it's resendable.
    console.log(`[vouchers] purchase emails failed for ${v.code}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Reminder to the gift recipient ("your voucher is waiting"), sent from the
 *  buyer's manage page. Requires a recipient email on the record. Returns
 *  whether the send was accepted. */
export async function sendVoucherReminderEmail(
  pid: string,
  v: VoucherRecord,
  origin: string,
  channel: string,
): Promise<boolean> {
  if (!v.gift?.recipientEmail) return false;
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid)]);
    const base = origin.replace(/\/+$/, "");
    const reminder = composeVoucherEmail({
      variant: "reminder",
      v,
      hotelName: ov.hotelName || "Your hotel",
      accent: accentHex(settings),
      currency: settings.currency || "GBP",
      voucherUrl: `${base}/${channel}/voucher/${v.code}`,
      shopUrl: `${base}/${channel}/vouchers`,
    });
    const r = await sendEmail({
      to: v.gift.recipientEmail,
      subject: reminder.subject,
      html: reminder.html,
      replyTo: settings.emailReplyTo,
    });
    return r.sent;
  } catch (e) {
    console.log(`[vouchers] reminder email failed for ${v.code}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Cooling-off cancellation emails: confirmation to the buyer (with the refund
 *  line when one was issued) and a notification to the hotel. Never throws. */
export async function sendVoucherCancelEmails(
  pid: string,
  v: VoucherRecord,
  opts: { refundAmount?: number; refundFailed?: boolean },
): Promise<void> {
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid)]);
    const hotelName = ov.hotelName || "Your hotel";
    const accent = accentHex(settings);
    const currency = settings.currency || "GBP";
    const money = (n: number) => formatMoney(n, currency);

    await sendEmail({
      to: v.buyer.email,
      subject: `Your ${hotelName} voucher has been cancelled`,
      html: renderSimpleEmail({
        hotelName,
        accent,
        heading: "Voucher cancelled",
        body:
          `Hi ${v.buyer.name} — your voucher "${v.product.title}" (${v.code}) has been cancelled as requested.\n\n` +
          (opts.refundAmount != null
            ? `${money(opts.refundAmount)} is on its way back to your original payment method. Depending on your bank it can take 5–10 business days to appear.`
            : opts.refundFailed
              ? `${hotelName} will process your ${money(v.product.price)} refund shortly.`
              : `No payment was taken for this voucher, so there is nothing to refund.`),
      }),
      replyTo: settings.emailReplyTo,
    });

    const hostTo = settings.hostNotifyEmail || ov.email;
    if (hostTo) {
      await sendEmail({
        to: hostTo,
        subject: `Voucher ${v.code} cancelled by the buyer`,
        html: renderSimpleEmail({
          hotelName,
          accent,
          heading: "A voucher was cancelled",
          body:
            `${v.buyer.name} (${v.buyer.email}) cancelled "${v.product.title}" (${v.code}) within the cooling-off window.\n\n` +
            (opts.refundAmount != null
              ? `The ${money(opts.refundAmount)} charge was refunded automatically.`
              : opts.refundFailed
                ? `⚠️ The automatic refund FAILED — please refund ${money(v.product.price)} manually from your Stripe dashboard.`
                : `No charge was taken (test/complimentary voucher), so no refund was needed.`),
        }),
        replyTo: v.buyer.email,
      });
    }
  } catch (e) {
    console.log(`[vouchers] cancel emails failed for ${v.code}: ${e instanceof Error ? e.message : e}`);
  }
}
