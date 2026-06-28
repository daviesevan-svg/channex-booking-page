import type { Route } from "./+types/api.test_connection";
import { checkApiKey } from "~/lib/ari.server";
import { isChannexConnected } from "~/lib/overrides.server";

// GET /api/test_connection?hotel_code=... — Channex health check.
export async function loader({ request }: Route.LoaderArgs) {
  const unauthorized = checkApiKey(request);
  if (unauthorized) return unauthorized;
  // Only respond OK for a property that has selected Channex as its connectivity.
  const hotelCode = new URL(request.url).searchParams.get("hotel_code") ?? "";
  if (hotelCode && !(await isChannexConnected(hotelCode))) {
    return Response.json(
      { success: false, error: "This property is not connected to Channex." },
      { status: 403 },
    );
  }
  return Response.json({ success: true });
}
