import type { Route } from "./+types/api.v1.bookings.$id";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { getBooking, getBookingByReference } from "~/lib/bookings.server";
import { getPending } from "~/lib/pending-bookings.server";
import { serializeBooking } from "~/lib/api-serialize";

// GET /v1/bookings/:id — a booking by its id OR its guest-facing reference.
//
// Both are accepted because creating a booking returns the REFERENCE, so that is
// what a caller holds when it comes back to check; requiring the internal id made
// the obvious follow-up call impossible.
//
// A booking awaiting payment does not exist in the booking table yet — it's a
// pending record consumed by the Stripe return or webhook. Reporting that as
// "not found" left a caller (or an AI agent that just handed the guest a
// payment_url) with no way to answer "have they paid?", which is the one question
// it needs. So the pending store is checked as a fallback and reported honestly.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;

  const b = (await getBooking(auth.pid, params.id)) ?? (await getBookingByReference(auth.pid, params.id));
  if (b) return Response.json({ data: serializeBooking(b) });

  // The pending store is keyed by reference alone, so ownership must be checked
  // here — otherwise one property's key could read another's pending booking.
  const pending = await getPending(params.id.trim().toUpperCase());
  if (pending && pending.pid === auth.pid) {
    const r = pending.record;
    // A deliberate projection, not the stored record: pending data carries the
    // same private fields serializeBooking exists to strip.
    return Response.json({
      data: {
        reference: r.reference,
        status: "pending_payment",
        paid: false,
        checkin: r.checkin,
        checkout: r.checkout,
        nights: r.nights,
        currency: r.currency,
        total: r.total,
        guest: { first_name: r.guest.firstName, last_name: r.guest.lastName, email: r.guest.email },
        rooms: r.rooms.map((room) => ({
          room_id: room.roomId,
          room_title: room.roomTitle,
          rate_id: room.rateId,
          rate_title: room.rateTitle,
          adults: room.adults,
          children: room.children,
          total: room.total,
        })),
        note: "Awaiting payment. The booking is created once the guest completes the payment_url, and this call then returns the confirmed booking. Unpaid holds expire after a few hours.",
      },
    });
  }

  return apiError(404, "not_found", "Booking not found.");
}
