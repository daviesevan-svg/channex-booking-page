import type { Route } from "./+types/api.v1.manage.property";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { serializeManageProperty } from "~/lib/manage-serialize";
import { validatePropertyPatch, validationError } from "~/lib/manage-validate";
import { getSettings, patchSettings } from "~/lib/overrides.server";
import { getProperty } from "~/lib/properties.server";

// GET   /v1/manage/property — the property + settings view (manage keys only).
// PATCH /v1/manage/property — sparse merge over the phase-A allowlist
//        (docs/management-api.md §4). Omitted = unchanged, null = clear.
//        Deliberately NOT writable here: connectedSystem (the live-traffic
//        gate), liveBooking, websiteDomain (order-sensitive claim flow),
//        payment fields, and the registry fields (slug/public — phase C).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const [ref, settings] = await Promise.all([getProperty(auth.pid), getSettings(auth.pid)]);
  if (!ref) return apiError(404, "not_found", "Property not found.");
  return Response.json({ data: serializeManageProperty(ref, settings) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const parsed = validatePropertyPatch(body);
  if (!parsed.ok) return validationError(parsed.errors);
  const ref = await getProperty(auth.pid);
  if (!ref) return apiError(404, "not_found", "Property not found.");
  const settings = await patchSettings(auth.pid, parsed.value);
  return Response.json({ data: serializeManageProperty(ref, settings) });
}
