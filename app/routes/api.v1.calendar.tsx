import type { Route } from "./+types/api.v1.calendar";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { getCalendarAvailability } from "~/lib/catalog.server";

// GET /v1/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — per-date availability for a
// date-picker (closed / closed-to-arrival / closed-to-departure / min-stay).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return apiError(400, "invalid_request", "`from` and `to` are required (YYYY-MM-DD).");
  }

  const c = await getCalendarAvailability(auth.pid, from, to);
  return Response.json({
    from,
    to,
    closed: c.closed,
    closed_to_arrival: c.closedToArrival,
    closed_to_departure: c.closedToDeparture,
    min_stay_arrival: c.minStayArrival,
    min_stay_through: c.minStayThrough,
  });
}
