import type { Route } from "./+types/api.v1.availability";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { getCatalogRooms } from "~/lib/catalog.server";
import { serializeAvailabilityRoom } from "~/lib/api-serialize";

// GET /v1/availability?checkin=&checkout=&adults=&children_ages=&currency=
// Priced, bookable rooms + rates for a chosen stay (the results screen).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin") ?? "";
  const checkout = url.searchParams.get("checkout") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) {
    return apiError(400, "invalid_request", "`checkin` and `checkout` are required (YYYY-MM-DD).");
  }
  const adults = Math.max(1, parseInt(url.searchParams.get("adults") ?? "2", 10) || 2);
  // children_ages takes precedence (ages affect pricing/infants); else a plain count.
  const agesParam = url.searchParams.get("children_ages");
  const childrenAge = agesParam
    ? agesParam.split(",").map((a) => parseInt(a.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0)
    : Array.from({ length: Math.max(0, parseInt(url.searchParams.get("children") ?? "0", 10) || 0) }, () => 8);

  const rooms = await getCatalogRooms(
    auth.pid,
    { checkinDate: checkin, checkoutDate: checkout, currency: url.searchParams.get("currency") || undefined, adults, childrenAge },
    { gate: true },
  );
  return Response.json({ checkin, checkout, data: rooms.map(serializeAvailabilityRoom) });
}
