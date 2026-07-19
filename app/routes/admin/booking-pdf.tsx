// Resource route: download a booking's confirmation as a PDF — for the hotel
// to print or forward manually when the guest didn't get the email.
import type { Route } from "./+types/booking-pdf";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getBooking } from "~/lib/bookings.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { accentHex } from "~/lib/email-render.server";
import { renderBookingPdf } from "~/lib/booking-pdf.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) throw new Response("No property selected", { status: 404 });
  const booking = await getBooking(propertyId, params.id);
  if (!booking) throw new Response("Booking not found", { status: 404 });

  const [settings, ov] = await Promise.all([getSettings(propertyId), getOverrides(propertyId, booking.lang)]);
  const bytes = await renderBookingPdf({
    booking,
    hotelName: ov.hotelName || "Your hotel",
    accent: accentHex(settings),
    address: ov.address,
    phone: ov.phone,
  });
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="confirmation-${booking.reference}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
