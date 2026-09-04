// The post-payment half of a booking: push to Channex, record, decrement
// inventory, email. Shared by the direct (no-payment) checkout path and the
// Stripe return URL + webhook. Idempotent by reference so the return URL and the
// webhook can't both create the booking.
import {
  claimBooking,
  stayAvailabilityItems,
  updateBooking,
  type BookingRecord,
  type BookingStatus,
  type PaymentInfo,
} from "./bookings.server";
import { availabilityShortfall, decrementAvailability } from "./ari/admin.server";
import { pushOpenChannelBooking, pushOpenChannelRevision } from "./open-channel.server";
import { getConfig } from "./config.server";
import { formatMoney, fromStripeMinor, toStripeMinor } from "./money";
import { refundBookingCharge } from "./refunds.server";
import { sendBookingEmails, sendBookingFailedEmail } from "./email.server";
import { deletePending, getPending, type PendingBooking } from "./pending-bookings.server";
import { releaseGiftHold, settleGiftHold } from "./vouchers.server";
import { createRefund, retrieveCheckoutSession, type CheckoutSession } from "./stripe.server";
import {
  SessionBindError,
  assertCollectedPayment,
  assertSessionMatchesPending,
  bookingSessionTarget,
  shouldRefundMismatchedSession,
} from "./stripe-session-bind";
import {
  retrieveVivaTransaction,
  toVivaMinor,
  vivaAlphaCurrency,
  vivaRefund,
  type VivaConfig,
  type VivaTransaction,
} from "./viva.server";
import { iyzicoPaid, iyzicoRefund, type IyzicoConfig, type IyzicoPaymentResult } from "./iyzico.server";
import { claimRefund, releaseRefundClaim } from "./refund-claim.server";
import { getVivaConfig } from "./overrides.server";
import { getVivaOrder } from "./pending-bookings.server";
import { dispatchWebhook } from "./webhooks.server";
import { queueFunnelEvent } from "./funnel-analytics.server";
import { serializeBooking } from "./api-serialize";

const idOf = (v: unknown): string | undefined =>
  typeof v === "string" ? v : v && typeof v === "object" ? (v as { id?: string }).id : undefined;

/** Turn a completed Checkout Session into the PaymentInfo we store, for either a
 *  charge (mode: payment) or a saved guarantee card (mode: setup). Returns null
 *  if the session isn't actually complete. */
export function paymentFromSession(account: string, sessionId: string, session: CheckoutSession): PaymentInfo | null {
  if (session.payment_status === "paid") {
    return {
      provider: "stripe",
      mode: "payment",
      accountId: account,
      sessionId,
      amount: fromStripeMinor(session.amount_total ?? 0, session.currency ?? ""),
      currency: (session.currency ?? "").toUpperCase() || undefined,
      paymentIntentId: idOf(session.payment_intent),
    };
  }
  if (session.mode === "setup" && session.status === "complete") {
    const si = typeof session.setup_intent === "object" ? session.setup_intent : undefined;
    const pm = si && typeof si.payment_method === "object" ? si.payment_method : undefined;
    return {
      provider: "stripe",
      mode: "setup",
      accountId: account,
      sessionId,
      customerId: idOf(session.customer),
      paymentMethodId: pm?.id ?? (typeof si?.payment_method === "string" ? si.payment_method : undefined),
      cardLast4: pm?.card?.last4,
      cardBrand: pm?.card?.brand,
    };
  }
  return null;
}

/** Turn a Viva transaction lookup into the PaymentInfo we store. Returns null
 *  unless the transaction is finished ("F") AND belongs to the given order —
 *  the return URL's ?t= parameter is guest-controlled, so an id that doesn't
 *  match the order it claims to pay proves nothing. */
export function paymentFromVivaTransaction(
  viva: VivaConfig,
  orderCode: string,
  transactionId: string,
  tx: VivaTransaction,
): PaymentInfo | null {
  if (tx.statusId !== "F") return null;
  if (String(tx.orderCode ?? "") !== orderCode) return null;
  return {
    provider: "viva",
    mode: "payment",
    accountId: viva.merchantId,
    sessionId: orderCode,
    transactionId,
    amount: tx.amount ?? 0,
    currency: vivaAlphaCurrency(tx.currencyCode),
  };
}

/**
 * A verified iyzico payment, as a PaymentInfo — or null if it isn't money.
 *
 * Three checks, and each is a way a POST to our public callback could otherwise
 * pay for the wrong booking: the payment must actually be complete (and not
 * held in a fraud review), the response must carry iyzico's own signature over
 * the fields we care about, and the reference iyzico echoes back must be the
 * booking being finalized. Amount and currency are checked after this, by
 * finalize's session bind.
 */
export function paymentFromIyzico(
  iyzico: IyzicoConfig,
  ref: string,
  result: IyzicoPaymentResult,
): PaymentInfo | null {
  if (!iyzicoPaid(result)) return null;
  if (!result.signatureVerified) return null;
  if (result.conversationId !== ref && result.basketId !== ref) return null;
  return {
    provider: "iyzico",
    mode: "payment",
    accountId: iyzico.merchantId ?? "",
    sessionId: ref,
    transactionId: result.paymentId,
    amount: result.paidPrice,
    currency: result.currency,
  };
}

/**
 * An iyzico charge finalize refused — the twin of the Viva and Stripe legs.
 * Refunded rather than kept, behind a once-only claim so a retry can't refund
 * twice.
 */
export async function rejectMismatchedIyzicoPayment(
  iyzico: IyzicoConfig,
  payment: PaymentInfo,
  ref: string,
  err: SessionBindError,
): Promise<void> {
  if (shouldRefundMismatchedSession(err.reason) && payment.transactionId) {
    const claimKey = `iyzico_mismatch:${ref}`;
    if (await claimRefund(claimKey)) {
      try {
        const res = await iyzicoRefund(iyzico, payment.transactionId, payment.amount ?? 0, payment.currency ?? "TRY");
        if (!res.refunded) throw new Error(res.message ?? "refused");
        console.error(`[finalize] refunded mismatched iyzico charge for ${ref} payment=${payment.transactionId}`);
      } catch (e) {
        await releaseRefundClaim(claimKey);
        console.error(
          `[finalize] mismatch refund failed for ${ref} iyzico payment=${payment.transactionId}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    await deletePending(ref);
  }
  console.error(`[finalize] reject ${ref}: ${err.message}`);
}

/** Look up the pending booking behind a Viva order code, verify the transaction
 *  against Viva's API, and finalize if it's paid. Shared by the return URL and
 *  the webhook — idempotent, so both firing is safe. Returns null when nothing
 *  is pending (already finalized / expired) or the payment isn't complete. */
export async function finalizeFromVivaOrder(orderCode: string, transactionId: string): Promise<BookingRecord | null> {
  const order = await getVivaOrder(orderCode);
  if (!order) return null;
  const pending = await getPending(order.ref);
  if (!pending) return null;
  const viva = await getVivaConfig(order.pid);
  if (!viva) return null; // disconnected mid-checkout — the operator's problem, don't guess
  const tx = await retrieveVivaTransaction(viva, transactionId);
  const payment = paymentFromVivaTransaction(viva, orderCode, transactionId, tx);
  if (!payment) return null;
  let record: BookingRecord;
  try {
    record = await finalizeBooking(pending, payment, pending.origin);
  } catch (e) {
    if (e instanceof SessionBindError) await rejectMismatchedVivaPayment(viva, payment, order.ref, e);
    throw e;
  }
  await deletePending(order.ref);
  // The order mapping is deliberately NOT deleted: if the webhook finalized
  // first, the guest's return URL still needs orderCode → ref/channel to land
  // on their confirmation. It expires with its TTL.
  return record;
}

/**
 * A Viva charge that finalize refused (amount or currency didn't match the
 * pending) is refunded, not kept — the Viva twin of `rejectUnboundStripeSession`.
 *
 * Until this existed the guest was sent back to checkout with the money gone
 * and no booking. It is reachable in practice: a Viva order carries no
 * currency, so the guest is charged in the MERCHANT account's currency while
 * the pending expects the PROPERTY's; a property whose currency differs from
 * (or was changed after connecting) its Viva account trips it on every sale.
 *
 * The return URL and the webhook both run this for the same order, so the
 * refund itself is behind a once-only claim — otherwise a rejected charge would
 * be refunded twice. Best-effort like the Stripe leg: a failed refund is logged
 * (and the claim released so a later delivery can retry), never thrown over
 * the original bind error.
 */
export async function rejectMismatchedVivaPayment(
  viva: VivaConfig,
  payment: PaymentInfo,
  ref: string,
  err: SessionBindError,
): Promise<void> {
  if (shouldRefundMismatchedSession(err.reason) && payment.transactionId) {
    const claimKey = `viva_mismatch:${ref}`;
    if (await claimRefund(claimKey)) {
      try {
        // Refund what Viva actually took, in the transaction's own currency:
        // `payment.amount` is tx.amount as Viva reported it.
        await vivaRefund(viva, payment.transactionId, toVivaMinor(payment.amount ?? 0));
        console.error(`[finalize] refunded mismatched Viva charge for ${ref} tx=${payment.transactionId}`);
      } catch (e) {
        await releaseRefundClaim(claimKey);
        console.error(
          `[finalize] mismatch refund failed for ${ref} viva tx=${payment.transactionId}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    await deletePending(ref);
  }
  console.error(`[finalize] reject ${ref}: ${err.message}`);
}

/** Enrich an Open Channel payload with how the booking was paid, once the
 *  payment outcome is known: a plain-text `notes` line (every PMS displays
 *  guest/booking notes) plus a structured `meta.payment` block with the amounts
 *  and the Stripe ids. The charge/setup ran on the hotel's own connected Stripe
 *  account, so an integrated PMS can use those ids with the hotel's keys to
 *  collect the balance or charge the guarantee card. */
export function payloadWithPayment(
  payload: unknown,
  booking: Pick<BookingRecord, "total" | "currency" | "payment" | "voucher">,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const { payment, currency } = booking;
  const voucherPaid = booking.voucher?.amount ?? 0;
  if (!payment && !voucherPaid) return payload;

  const charged = payment?.mode === "payment" ? (payment.amount ?? 0) : 0;
  // Balance computed in Stripe minor units so a float remainder can't turn a
  // fully-paid booking into a one-cent "deposit".
  const balance = fromStripeMinor(
    Math.max(0, toStripeMinor(booking.total, currency) - toStripeMinor(charged + voucherPaid, currency)),
    currency,
  );

  const base = payload as Record<string, unknown>;
  const fmt = (n: number) => formatMoney(n, currency);
  // Append to any note set at prepare time (e.g. the gift-voucher line).
  const lines = typeof base.notes === "string" && base.notes ? [base.notes] : [];
  const gatewayName = payment?.provider === "viva" ? "Viva" : payment?.provider === "iyzico" ? "iyzico" : "Stripe";
  if (payment?.provider === "stripe" || payment?.provider === "viva" || payment?.provider === "iyzico") {
    if (payment.mode === "payment") {
      lines.push(
        balance > 0
          ? `Deposit of ${fmt(charged)} collected via ${gatewayName} at booking. Balance due: ${fmt(balance)}.`
          : `Fully prepaid — ${fmt(charged)} collected via ${gatewayName} at booking.`,
      );
    } else {
      const card = [payment.cardBrand, payment.cardLast4 ? `**** ${payment.cardLast4}` : ""].filter(Boolean).join(" ");
      lines.push(
        `No charge taken at booking — card on file with ${gatewayName} as guarantee${card ? ` (${card})` : ""}. Balance due: ${fmt(balance)}.`,
      );
    }
  }

  const type = payment?.mode === "setup" ? "guarantee_card" : balance > 0 ? "deposit" : "full_prepayment";
  return {
    ...base,
    ...(lines.length ? { notes: lines.join("\n") } : {}),
    meta: {
      ...(base.meta && typeof base.meta === "object" ? (base.meta as Record<string, unknown>) : {}),
      payment: {
        type,
        currency,
        paid_at_booking: charged + voucherPaid,
        balance_due: balance,
        ...(payment?.provider === "stripe"
          ? {
              provider: "stripe",
              stripe_account: payment.accountId,
              stripe_checkout_session: payment.sessionId,
              ...(payment.paymentIntentId ? { stripe_payment_intent: payment.paymentIntentId } : {}),
              ...(payment.customerId ? { stripe_customer: payment.customerId } : {}),
              ...(payment.paymentMethodId ? { stripe_payment_method: payment.paymentMethodId } : {}),
              ...(payment.cardBrand ? { card_brand: payment.cardBrand } : {}),
              ...(payment.cardLast4 ? { card_last4: payment.cardLast4 } : {}),
            }
          : payment?.provider === "viva"
            ? {
                provider: "viva",
                viva_merchant: payment.accountId,
                viva_order_code: payment.sessionId,
                ...(payment.transactionId ? { viva_transaction: payment.transactionId } : {}),
              }
            : payment
              ? { provider: payment.provider }
              : {}),
        ...(voucherPaid && booking.voucher
          ? { gift_voucher: { code: booking.voucher.code, amount: voucherPaid } }
          : {}),
      },
    },
  };
}

/** Refund a bound-but-mismatched Stripe charge so we don't keep money we
 *  refuse to fulfil. Best-effort: a failed refund is logged for the operator. */
export async function refundRejectedStripeSession(
  account: string,
  session: CheckoutSession,
  ref: string,
): Promise<void> {
  const pi =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent.id
        : undefined;
  if (!pi) return;
  try {
    await createRefund(account, pi, undefined, `mismatch_${ref}`);
  } catch (e) {
    console.error(
      `[finalize] mismatch refund failed for ${ref} pi=${pi}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

export async function rejectUnboundStripeSession(
  account: string,
  session: CheckoutSession,
  ref: string,
  err: SessionBindError,
): Promise<never> {
  if (shouldRefundMismatchedSession(err.reason)) {
    await refundRejectedStripeSession(account, session, ref);
    await deletePending(ref);
  }
  console.error(`[finalize] reject ${ref}: ${err.message}`);
  throw err;
}

/** Look up the pending booking, retrieve its Stripe session, bind it to that
 *  pending, and finalize if it completed. Used by the return URL and the
 *  webhook backstop. No-op if nothing pending (already finalized / expired)
 *  or unpaid. Throws SessionBindError if the session is not this pending's. */
export async function finalizeFromStripeSession(ref: string, sessionId: string): Promise<BookingRecord | null> {
  const pending = await getPending(ref);
  if (!pending) return null;
  const session = await retrieveCheckoutSession(pending.account, sessionId);
  try {
    assertSessionMatchesPending(session, bookingSessionTarget(pending));
  } catch (e) {
    if (e instanceof SessionBindError) await rejectUnboundStripeSession(pending.account, session, ref, e);
    throw e;
  }
  const payment = paymentFromSession(pending.account, sessionId, session);
  if (!payment) return null;
  const record = await finalizeBooking(pending, payment, pending.origin);
  await deletePending(ref);
  return record;
}

/** Create the booking from a prepared draft. Returns the stored record. If a
 *  booking with the same reference already exists, returns it untouched. */
/**
 * Run a follow-up step that happens AFTER the booking row is committed.
 *
 * By this point the guest has a booking: the reference is claimed, the record
 * is persisted, and on a live property the PMS already has it. Everything that
 * remains — inventory, the voucher hold, email, the webhook — is bookkeeping,
 * and none of it is worth failing the request the guest is waiting on. A throw
 * here reached the checkout action and rendered the root error boundary, so a
 * guest whose booking had been created, pushed AND emailed was shown "an
 * unexpected error occurred" and had no way to tell whether they had booked.
 *
 * Loud on failure, and never rethrows: whatever went wrong, the caller has to
 * be able to send the guest to their confirmation.
 */
export async function afterCommit(reference: string, step: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (e) {
    console.error(
      `[finalize] ${step} failed after booking ${reference} was committed: ${e instanceof Error ? (e.stack ?? e.message) : e}`,
    );
  }
}

export async function finalizeBooking(
  pending: PendingBooking,
  payment: PaymentInfo | undefined,
  origin: string,
): Promise<BookingRecord> {
  const { pid, record: draft, live } = pending;
  // Fail closed BEFORE claiming the reference / pushing to Channex. A swapped
  // cheap session (or a setup session on a deposit pending) must not confirm
  // the stay. Missing `payment` is the test-mode / no-gateway path.
  const expected = bookingSessionTarget(pending);
  assertCollectedPayment(
    payment,
    { mode: expected.expectedMode, amount: expected.expectedAmount, currency: expected.expectedCurrency },
    draft.reference,
  );

  // The payload was assembled before payment; now the outcome is known, stamp
  // how the guest paid onto it (notes + meta) so the PMS sees the split.
  const channexPayload = payloadWithPayment(pending.channexPayload, {
    total: draft.total,
    currency: draft.currency,
    payment,
    voucher: draft.voucher,
  });

  // Atomically claim the reference. Only the winner proceeds to the side effects
  // below (Channex push, inventory, emails); a concurrent finalize (Stripe return
  // URL vs webhook) loses the claim and returns the existing record untouched.
  const provisional: BookingRecord = { ...draft, status: "simulated", inventoryHeld: false, payment };
  const claim = await claimBooking(pid, provisional);
  if (!claim.won) return claim.existing ?? provisional;

  let status: BookingStatus = "simulated";
  let channexId: string | undefined;
  let error: string | undefined;
  // `unavailable` = the room sold out before payment completed (definitive; no
  // retry can recover it). A plain push failure may be transient (retryable).
  let unavailable = false;
  if (live) {
    // Re-check availability right before committing — between checkout and
    // payment completion the room may have sold via another channel. Our ARI is
    // a cache (Channex is the source of truth), so this is best-effort; Channex
    // still rejects a genuinely oversold push below.
    const items = stayAvailabilityItems(draft.rooms, draft.checkin, draft.nights);
    if (await availabilityShortfall(pid, items)) {
      status = "failed";
      error = "Rooms are no longer available for these dates.";
      unavailable = true;
    } else {
      try {
        const result = (await pushOpenChannelBooking(channexPayload)) as { reservation_id?: string; id?: string } | undefined;
        channexId = result?.reservation_id || result?.id || undefined;
        status = "confirmed";
      } catch (e) {
        status = "failed";
        error = e instanceof Error ? e.message : "The channel manager rejected the booking.";
      }
    }
  }

  // Persist the final state onto the row we claimed above.
  const patch: Partial<BookingRecord> = {
    status,
    channexId,
    error,
    // Keep the payload: on a (transient) push failure so an admin can retry, and
    // on a confirmed live booking so we can re-send it as a cancellation revision.
    // Only drop it when the rooms were gone (a retry can't recover sold inventory).
    channexPayload: unavailable ? undefined : channexPayload,
    inventoryHeld: status !== "failed",
    payment,
  };
  let record: BookingRecord = (await updateBooking(pid, draft.id, patch)) ?? { ...provisional, ...patch };

  // Gift voucher applied at checkout: the hold placed at session creation is
  // settled onto the voucher (balance spent) when the booking stands, released
  // when it failed. Best-effort — the hold's TTL is the backstop either way.
  if (pending.voucherRedemption) {
    const { code } = pending.voucherRedemption;
    await afterCommit(draft.reference, "gift voucher hold", () =>
      status !== "failed"
        ? settleGiftHold(pid, code, draft.reference, record.id)
        : releaseGiftHold(pid, code, draft.reference),
    );
  }

  // Everything below runs after the commit, so every step is guarded — see
  // afterCommit. Inventory in particular: a failure there leaves our cached
  // availability one room high until the channel manager pushes the correct
  // figure back, which is worth a loud log and is NOT worth telling a guest
  // their confirmed booking errored.
  if (status !== "failed") {
    const ref = draft.reference;
    await afterCommit(ref, "inventory decrement", () =>
      decrementAvailability(pid, stayAvailabilityItems(record.rooms, record.checkin, record.nights)),
    );
    await afterCommit(ref, "booking emails", () => sendBookingEmails(pid, record, origin));
    await afterCommit(ref, "booking.created webhook", () =>
      dispatchWebhook(pid, "booking.created", serializeBooking(record), Date.now()),
    );
    // Funnel analytics: the ONE place every booking passes exactly once (the
    // claim above already de-raced Stripe-return vs webhook), so this counts
    // bookings no client-side tag can see — e.g. the guest who paid and closed
    // the tab. Web checkouts carry their visit context on the pending booking;
    // API/agent bookings have none and are reported as their own source.
    queueFunnelEvent({
      propertyId: pid,
      step: "purchase",
      visitKey: pending.funnel?.visitKey ?? "",
      source: pending.funnel ? "web" : "api",
      checkin: record.checkin,
      nights: record.nights,
      adults: record.rooms.reduce((s, r) => s + r.adults, 0),
      children: record.rooms.reduce((s, r) => s + r.children, 0),
      rooms: record.rooms.length,
      value: record.total,
      currency: record.currency,
      country: pending.funnel?.country ?? null,
      lang: record.lang ?? null,
      device: pending.funnel?.device ?? null,
    });
  } else if (unavailable && payment?.mode === "payment") {
    // Charged, but we can't fulfil the stay — always refund (this is our failure,
    // not a discretionary cancellation). refundBookingCharge is idempotent + safe.
    await afterCommit(draft.reference, "auto-refund of an unfulfillable stay", async () => {
      const r = await refundBookingCharge(pid, record, { by: "auto (unavailable at booking)" });
      if (r.ok) record = r.booking;
    });
    // Tell the guest we couldn't confirm and have refunded them.
    await afterCommit(draft.reference, "booking-failed email", () => sendBookingFailedEmail(pid, record, origin));
  }
  return record;
}

/** Re-attempt the Channex push for a booking that failed. On success, flips it to
 *  confirmed and runs the same post-booking steps finalizeBooking does (inventory,
 *  email, webhook). Mirrors the success path so a retry is indistinguishable from a
 *  first-try success. */
export async function retryChannexPush(
  pid: string,
  booking: BookingRecord,
  origin: string,
): Promise<{ ok: true; booking: BookingRecord } | { ok: false; reason: "not_failed" | "no_payload" | "push_failed"; error?: string }> {
  if (booking.status !== "failed") return { ok: false, reason: "not_failed" };
  if (!booking.channexPayload) return { ok: false, reason: "no_payload" };
  try {
    const result = (await pushOpenChannelBooking(booking.channexPayload)) as { reservation_id?: string; id?: string } | undefined;
    const channexId = result?.reservation_id || result?.id || undefined;
    const updated = await updateBooking(pid, booking.id, {
      status: "confirmed",
      channexId,
      error: undefined,
      // Keep the payload — a now-live booking may still need a cancellation push.
      inventoryHeld: true,
    });
    const finalBooking = updated ?? booking;
    await decrementAvailability(pid, stayAvailabilityItems(finalBooking.rooms, finalBooking.checkin, finalBooking.nights));
    await sendBookingEmails(pid, finalBooking, origin);
    await dispatchWebhook(pid, "booking.created", serializeBooking(finalBooking), Date.now());
    return { ok: true, booking: finalBooking };
  } catch (e) {
    const error = e instanceof Error ? e.message : "The channel manager rejected the booking.";
    await updateBooking(pid, booking.id, { error });
    return { ok: false, reason: "push_failed", error };
  }
}

/** Push a cancellation to Channex for a booking that was pushed live (has a
 *  channexId), so the hotel's PMS doesn't keep an active reservation after the
 *  guest has been cancelled/refunded. Best-effort: re-sends the original payload
 *  as a "cancelled" revision (falling back to a minimal one), never throws. */
export async function cancelChannexBooking(pid: string, booking: BookingRecord): Promise<void> {
  if (!booking.channexId) return; // never pushed live — nothing upstream to cancel
  const cfg = getConfig();
  const base =
    booking.channexPayload && typeof booking.channexPayload === "object"
      ? (booking.channexPayload as Record<string, unknown>)
      : {
          provider_code: cfg.providerCode,
          hotel_code: pid,
          ota_name: cfg.providerCode || "Direct",
          reservation_id: booking.reference,
          currency: booking.currency,
          arrival_date: booking.checkin,
          departure_date: booking.checkout,
          customer: {
            name: booking.guest.firstName,
            surname: booking.guest.lastName,
            mail: booking.guest.email,
            phone: booking.guest.phone,
          },
        };
  const res = await pushOpenChannelRevision({ ...base, status: "cancelled" });
  if (!res.ok) {
    console.log(`[open-channel] cancellation push failed for ${booking.reference}: ${res.error}`);
  }
}

/** Patch the customer (and per-room guests) inside a stored Open Channel
 *  payload so revisions carry the corrected guest details. */
export function payloadWithGuest(payload: unknown, guest: BookingRecord["guest"]): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const base = payload as Record<string, unknown>;
  const rooms = Array.isArray(base.rooms)
    ? base.rooms.map((r) =>
        r && typeof r === "object"
          ? { ...(r as Record<string, unknown>), guests: [{ name: guest.firstName, surname: guest.lastName }] }
          : r,
      )
    : base.rooms;
  return {
    ...base,
    customer: { name: guest.firstName, surname: guest.lastName, mail: guest.email, phone: guest.phone },
    rooms,
  };
}

/** Push a "modified" revision to Channex after an admin edits guest details, so
 *  the hotel's PMS copy carries the corrected name/email/phone. Same payload as
 *  the original push (keyed by reservation_id), status "modified". Best-effort:
 *  the local edit stands even if the push fails. */
export async function pushGuestModification(
  pid: string,
  booking: BookingRecord,
): Promise<{ pushed: boolean; error?: string }> {
  if (!booking.channexId) return { pushed: false }; // never pushed live — nothing upstream to update
  const cfg = getConfig();
  const base =
    payloadWithGuest(booking.channexPayload, booking.guest) ?? {
      provider_code: cfg.providerCode,
      hotel_code: pid,
      ota_name: cfg.providerCode || "Direct",
      reservation_id: booking.reference,
      currency: booking.currency,
      arrival_date: booking.checkin,
      departure_date: booking.checkout,
      customer: {
        name: booking.guest.firstName,
        surname: booking.guest.lastName,
        mail: booking.guest.email,
        phone: booking.guest.phone,
      },
    };
  const res = await pushOpenChannelRevision({ ...base, status: "modified" });
  if (!res.ok) console.log(`[open-channel] modification push failed for ${booking.reference}: ${res.error}`);
  return { pushed: res.ok, error: res.error };
}
