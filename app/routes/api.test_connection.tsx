import type { Route } from "./+types/api.test_connection";
import { checkApiKey } from "~/lib/ari.server";

// GET /api/test_connection?hotel_code=... — Channex health check.
export async function loader({ request }: Route.LoaderArgs) {
  const unauthorized = checkApiKey(request);
  if (unauthorized) return unauthorized;
  return Response.json({ success: true });
}
