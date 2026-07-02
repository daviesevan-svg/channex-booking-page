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
import { availabilityShortfall, decrementAvailability } from "./ari.server";
import { pushOpenChannelBooking, pushOpenChannelCancellation } from "./open-channel.server";
import { getConfig } from "./config.server";
import { refundBookingCharge } from "./refunds.server";
import { sendBookingEmails, sendBookingFailedEmail } from "./email.server";
import { deletePending, getPending, type PendingBooking } from "./pending-bookings.server";
import { retrieveCheckoutSession, type CheckoutSession } from "./stripe.server";
import { dispatchWebhook } from "./webhooks.server";
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
      amount: (session.amount_total ?? 0) / 100,
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

/** Look up the pending booking, retrieve its Stripe session, and finalize if it
 *  completed. Used by the webhook backstop. No-op if nothing pending or unpaid. */
export async function finalizeFromStripeSession(ref: string, sessionId: string): Promise<BookingRecord | null> {
  const pending = await getPending(ref);
  if (!pending) return null;
  const session = await retrieveCheckoutSession(pending.account, sessionId);
  const payment = paymentFromSession(pending.account, sessionId, session);
  if (!payment) return null;
  const record = await finalizeBooking(pending, payment, pending.origin);
  await deletePending(ref);
  return record;
}

/** Create the booking from a prepared draft. Returns the stored record. If a
 *  booking with the same reference already exists, returns it untouched. */
export async function finalizeBooking(
  pending: PendingBooking,
  payment: PaymentInfo | undefined,
  origin: string,
): Promise<BookingRecord> {
  const { pid, record: draft, channexPayload, live } = pending;

  // Atomically claim the reference. Only the winner proceeds to the side effects
  // below (Channex push, inventory, emails); a concurrent finalize (Stripe return
  // URL vs webhook) loses the claim and returns the existing record untouched.
  const provisional: BookingRecord = { ...draft, status: "simulated", inventoryHeld: false, payment };
  const claim = await claimBooking(pid, provisional);
  if (!claim.won) return claim.existing ?? provisional;

  // Defensive tripwire: the charge is server-authored (we created the Stripe
  // session with our own amount/currency and re-fetch it by id), so what the
  // guest paid must equal what we intended. If it ever doesn't, a bug or a
  // session mix-up let a wrong amount through — record what they actually paid
  // (below) but shout loudly so it's caught in logs/tests rather than silently.
  if (payment?.mode === "payment") {
    const expectedMinor = Math.round((draft.consent?.dueNow ?? 0) * 100);
    const gotMinor = Math.round((payment.amount ?? 0) * 100);
    const expCur = (draft.currency || "").toUpperCase();
    const gotCur = (payment.currency || "").toUpperCase();
    if (expectedMinor !== gotMinor || (expCur && gotCur && expCur !== gotCur)) {
      console.error(
        `[finalize] CHARGE MISMATCH for ${draft.reference}: expected ${expectedMinor} ${expCur}, Stripe reported ${gotMinor} ${gotCur}`,
      );
    }
  }

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
        error = e instanceof Error ? e.message : "Channex rejected the booking.";
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

  if (status !== "failed") {
    await decrementAvailability(pid, stayAvailabilityItems(record.rooms, record.checkin, record.nights));
    await sendBookingEmails(pid, record, origin);
    await dispatchWebhook(pid, "booking.created", serializeBooking(record), Date.now());
  } else if (unavailable && payment?.mode === "payment") {
    // Charged, but we can't fulfil the stay — always refund (this is our failure,
    // not a discretionary cancellation). refundBookingCharge is idempotent + safe.
    const r = await refundBookingCharge(pid, record, { by: "auto (unavailable at booking)" });
    if (r.ok) record = r.booking;
    // Tell the guest we couldn't confirm and have refunded them.
    await sendBookingFailedEmail(pid, record, origin);
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
    const error = e instanceof Error ? e.message : "Channex rejected the booking.";
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
  const res = await pushOpenChannelCancellation({ ...base, status: "cancelled" });
  if (!res.ok) {
    console.log(`[open-channel] cancellation push failed for ${booking.reference}: ${res.error}`);
  }
}
