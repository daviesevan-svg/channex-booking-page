// The post-payment half of a booking: push to Channex, record, decrement
// inventory, email. Shared by the direct (no-payment) checkout path and the
// Stripe return URL + webhook. Idempotent by reference so the return URL and the
// webhook can't both create the booking.
import {
  getBookings,
  recordBooking,
  stayAvailabilityItems,
  type BookingRecord,
  type BookingStatus,
  type PaymentInfo,
} from "./bookings.server";
import { decrementAvailability } from "./ari.server";
import { pushOpenChannelBooking } from "./open-channel.server";
import { sendBookingEmails } from "./email.server";
import type { PendingBooking } from "./pending-bookings.server";

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
    inventoryHeld: status !== "failed",
    payment,
  };
  await recordBooking(pid, record);

  if (status !== "failed") {
    await decrementAvailability(pid, stayAvailabilityItems(record.rooms, record.checkin, record.nights));
    await sendBookingEmails(pid, record, origin);
  }
  return record;
}
