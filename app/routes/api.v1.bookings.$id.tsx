import type { Route } from "./+types/api.v1.bookings.$id";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { getBooking } from "~/lib/bookings.server";
import { serializeBooking } from "~/lib/api-serialize";

// GET /v1/bookings/:id — a single booking by its id.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  const b = await getBooking(auth.pid, params.id);
  if (!b) return apiError(404, "not_found", "Booking not found.");
  return Response.json({ data: serializeBooking(b) });
}
