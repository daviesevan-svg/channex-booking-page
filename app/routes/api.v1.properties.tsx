import type { Route } from "./+types/api.v1.properties";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { accentHex } from "~/lib/email-render.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { getProperty } from "~/lib/properties.server";
import { serializePropertyContent } from "~/lib/api-serialize";

// GET /v1/properties?lang= — the property this key is scoped to, with the
// display content an external booking frontend needs (branding, contact,
// location, stay logistics, theme, tax/fee display config). Text fields come
// localized when ?lang= names an enabled language (else the default).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  const p = await getProperty(auth.pid);
  if (!p) return apiError(404, "not_found", "Property not found.");
  const lang = new URL(request.url).searchParams.get("lang") ?? undefined;
  const [settings, ov] = await Promise.all([getSettings(auth.pid), getOverrides(auth.pid, lang)]);
  return Response.json({ data: serializePropertyContent(p, settings, ov, accentHex(settings)) });
}
