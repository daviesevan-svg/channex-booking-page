// The post-payment half of a booking: push to Channex, record, decrement
// inventory, email. Shared by the direct (no-payment) checkout path and the
// Stripe return URL + webhook. Idempotent by reference so the return URL and the
// webhook can't both create the booking.
import {
  getBookings,
  recordBooking,
  stayAvailabilityItems,
  updateBooking,
  type BookingRecord,
  type BookingStatus,
  type PaymentInfo,
} from "./bookings.server";
import { decrementAvailability } from "./ari.server";
import { pushOpenChannelBooking } from "./open-channel.server";
import { sendBookingEmails } from "./email.server";
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

  const existing = (await getBookings(pid)).find((b) => b.reference === draft.reference);
  if (existing) return existing; // idempotent — already finalized by the other path

  let status: BookingStatus = "simulated";
  let channexId: string | undefined;
  let error: string | undefined;
  if (live) {
    try {
      const result = (await pushOpenChannelBooking(channexPayload)) as { reservation_id?: string; id?: string } | undefined;
      channexId = result?.reservation_id || result?.id || undefined;
      status = "confirmed";
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : "Channex rejected the booking.";
    }
  }

  const record: BookingRecord = {
    ...draft,
    status,
    channexId,
    error,
    // Keep the payload only on failure, so an admin can retry the exact push.
    channexPayload: status === "failed" ? channexPayload : undefined,
    inventoryHeld: status !== "failed",
    payment,
  };
  await recordBooking(pid, record);

  if (status !== "failed") {
    await decrementAvailability(pid, stayAvailabilityItems(record.rooms, record.checkin, record.nights));
    await sendBookingEmails(pid, record, origin);
    await dispatchWebhook(pid, "booking.created", serializeBooking(record), Date.now());
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
      channexPayload: undefined,
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
