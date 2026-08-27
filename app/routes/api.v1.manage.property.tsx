import type { Route } from "./+types/api.v1.manage.property";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { serializeManageProperty } from "~/lib/manage-serialize";
import { getSettings } from "~/lib/overrides.server";
import { getProperty } from "~/lib/properties.server";

// GET /v1/manage/property — the property + settings view (manage keys only).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const [ref, settings] = await Promise.all([getProperty(auth.pid), getSettings(auth.pid)]);
  if (!ref) return apiError(404, "not_found", "Property not found.");
  return Response.json({ data: serializeManageProperty(ref, settings) });
}
