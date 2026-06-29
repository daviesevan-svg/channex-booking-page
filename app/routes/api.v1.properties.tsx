import type { Route } from "./+types/api.v1.properties";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { getProperty } from "~/lib/properties.server";
import { serializeProperty } from "~/lib/api-serialize";

// GET /v1/properties — the property this key is scoped to.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  const p = await getProperty(auth.pid);
  if (!p) return apiError(404, "not_found", "Property not found.");
  return Response.json({ data: serializeProperty(p) });
}
