import type { Route } from "./+types/api.v1.manage.rates.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { deleteRate, getRates, getRooms, saveRate } from "~/lib/catalog.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { serializeManageRate } from "~/lib/manage-serialize";
import { validateRateInput, validationError } from "~/lib/manage-validate";
import { buildRate } from "./api.v1.manage.rates";

// GET /v1/manage/rates/:id · PATCH (sparse merge; channex_rate_ids and the
// legacy perPerson flag are server-owned and always preserved) · DELETE.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const rate = (await getRates(auth.pid)).find((r) => r.id === String(params.id ?? ""));
  if (!rate) return apiError(404, "not_found", "No rate plan with that id.");
  return Response.json({ data: serializeManageRate(rate) });
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const rate = (await getRates(auth.pid)).find((r) => r.id === String(params.id ?? ""));
  if (!rate) return apiError(404, "not_found", "No rate plan with that id.");

  if (request.method === "DELETE") {
    await deleteRate(auth.pid, rate.id);
    await queueGoogleAriPush(auth.pid, ["property_data", "ari"]);
    return Response.json({ deleted: true });
  }

  if (request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "bad_request", "Body must be JSON.");
    }
    const roomIds = new Set((await getRooms(auth.pid)).map((r) => r.id));
    const parsed = validateRateInput(body, { create: false, roomIds });
    if (!parsed.ok) return validationError(parsed.errors);
    const next = buildRate(parsed.value, rate);
    await saveRate(auth.pid, next);
    await queueGoogleAriPush(auth.pid, ["property_data", "ari"]);
    return Response.json({ data: serializeManageRate(next) });
  }

  return apiError(405, "method_not_allowed", "Use PATCH to edit or DELETE to remove.");
}
