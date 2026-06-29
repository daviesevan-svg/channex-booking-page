import type { Route } from "./+types/api.v1.properties.$id";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { getProperty } from "~/lib/properties.server";
import { serializeProperty } from "~/lib/api-serialize";

// GET /v1/properties/:id — must match the key's property (keys are per-property).
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  if (params.id !== auth.pid) return apiError(403, "forbidden", "This API key is not scoped to that property.");
  const p = await getProperty(auth.pid);
  if (!p) return apiError(404, "not_found", "Property not found.");
  return Response.json({ data: serializeProperty(p) });
}
