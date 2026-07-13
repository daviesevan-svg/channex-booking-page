import type { Route } from "./+types/api.v1.properties.$id";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { accentHex } from "~/lib/email-render.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { getProperty } from "~/lib/properties.server";
import { serializePropertyContent } from "~/lib/api-serialize";

// GET /v1/properties/:id?lang= — must match the key's property (keys are
// per-property). Same enriched shape as GET /v1/properties.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  if (params.id !== auth.pid) return apiError(403, "forbidden", "This API key is not scoped to that property.");
  const p = await getProperty(auth.pid);
  if (!p) return apiError(404, "not_found", "Property not found.");
  const lang = new URL(request.url).searchParams.get("lang") ?? undefined;
  const [settings, ov] = await Promise.all([getSettings(auth.pid), getOverrides(auth.pid, lang)]);
  return Response.json({ data: serializePropertyContent(p, settings, ov, accentHex(settings)) });
}
