import type { Route } from "./+types/api.v1.bookings";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { getBookings } from "~/lib/bookings.server";
import { serializeBooking } from "~/lib/api-serialize";

// GET /v1/bookings?limit=&offset= — the property's bookings, newest first.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const all = await getBookings(auth.pid);
  const page = all.slice(offset, offset + limit);
  return Response.json({ data: page.map(serializeBooking), total: all.length, limit, offset });
}
