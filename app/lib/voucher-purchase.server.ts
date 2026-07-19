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

/** Purchase emails (fixed English copy v1): a receipt to the buyer, and — when
 *  bought as a gift with a recipient email — the voucher itself to the
 *  recipient with the buyer's message. When there's no recipient email the
 *  buyer's mail carries the code (they hand it over themselves). */
export async function sendVoucherEmails(
  pid: string,
  v: VoucherRecord,
  origin: string,
  channel: string,
): Promise<void> {
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid)]);
    const hotelName = ov.hotelName || "Your hotel";
    const accent = accentHex(settings);
    const currency = settings.currency || "GBP";
    const voucherUrl = `${origin.replace(/\/+$/, "")}/${channel}/voucher/${v.code}`;
    const money = (n: number) => formatMoney(n, currency);
    const what =
      v.kind === "gift"
        ? `a ${money(v.product.value ?? v.product.price)} gift voucher`
        : `"${v.product.title}"`;
    const expiry = `Valid until ${v.expiresAt.slice(0, 10)}.`;
    const sentToRecipient = Boolean(v.gift?.recipientEmail);

    // Buyer receipt.
    await sendEmail({
      to: v.buyer.email,
      subject: `Your ${hotelName} voucher — ${v.product.title}`,
      html: renderSimpleEmail({
        hotelName,
        accent,
        heading: sentToRecipient ? "Your gift is on its way!" : "Here's your voucher",
        body:
          `Thanks, ${v.buyer.name} — you've bought ${what} for ${money(v.product.price)}.\n\n` +
          (sentToRecipient
            ? `We've emailed the voucher to ${v.gift!.recipientName} (${v.gift!.recipientEmail}).`
            : `Your voucher code is ${v.code}. Keep it safe — whoever holds the code can use it.`) +
          `\n\n${expiry}`,
        cta: { label: "View the voucher", url: voucherUrl },
      }),
      replyTo: settings.emailReplyTo,
    });

    // Gift delivery to the recipient.
    if (sentToRecipient) {
      await sendEmail({
        to: v.gift!.recipientEmail!,
        subject: `${v.buyer.name} sent you a gift from ${hotelName} 🎁`,
        html: renderSimpleEmail({
          hotelName,
          accent,
          heading: `A gift for you, ${v.gift!.recipientName}!`,
          body:
            `${v.buyer.name} has bought you ${what} at ${hotelName}.` +
            (v.gift?.message ? `\n\n“${v.gift.message}”` : "") +
            `\n\nYour voucher code is ${v.code}.` +
            (v.kind === "package"
              ? `\n\nYou can book your stay online — pick your dates on the voucher page below.`
              : `\n\nUse the code at checkout on ${hotelName}'s booking page to pay with your voucher.`) +
            `\n\n${expiry}`,
          cta: { label: v.kind === "package" ? "View & book your stay" : "View your voucher", url: voucherUrl },
        }),
        replyTo: settings.emailReplyTo,
      });
    }
  } catch (e) {
    // Never fail an issued (paid) voucher over email delivery — it's resendable.
    console.log(`[vouchers] purchase emails failed for ${v.code}: ${e instanceof Error ? e.message : e}`);
  }
}
