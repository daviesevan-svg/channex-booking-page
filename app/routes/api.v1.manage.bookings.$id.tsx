import type { Route } from "./+types/api.v1.manage.bookings.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { getBooking, getBookingByReference } from "~/lib/bookings.server";
import { serializeManageBooking } from "~/lib/manage-serialize";

// GET /v1/manage/bookings/:id — one booking, by internal id or guest-facing
// reference. Read-only (see the list route for why).
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const key = String(params.id ?? "").trim();
  if (!key) return apiError(404, "not_found", "No booking id given.");
  const booking = (await getBooking(auth.pid, key)) ?? (await getBookingByReference(auth.pid, key));
  if (!booking) return apiError(404, "not_found", "No booking with that id or reference.");
  return Response.json({ data: serializeManageBooking(booking) });
}
