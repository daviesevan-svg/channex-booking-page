import type { Route } from "./+types/api.mapping_details";
import { checkApiKey } from "~/lib/ari.server";
import { getCatalogMapping } from "~/lib/catalog.server";

// GET /api/mapping_details?hotel_code=... — our room/rate catalog for mapping.
export async function loader({ request }: Route.LoaderArgs) {
  const unauthorized = checkApiKey(request);
  if (unauthorized) return unauthorized;
  const hotelCode = new URL(request.url).searchParams.get("hotel_code") ?? "";
  const room_types = await getCatalogMapping(hotelCode);
  return Response.json({ data: { type: "mapping_details", attributes: { room_types } } });
}
