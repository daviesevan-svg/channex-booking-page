import type { Route } from "./+types/api.v1.manage.extras.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { deleteExtra, getExtras, saveExtra } from "~/lib/extras.server";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { serializeManageExtra } from "~/lib/manage-serialize";
import { catalogIds } from "~/lib/manage-catalog.server";
import { validateExtraInput, validationError } from "~/lib/manage-validate";
import { buildExtra } from "./api.v1.manage.extras";

// GET /v1/manage/extras/:id · PATCH (sparse merge) · DELETE.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const extra = (await getExtras(auth.pid)).find((e) => e.id === String(params.id ?? ""));
  if (!extra) return apiError(404, "not_found", "No extra with that id.");
  return Response.json({ data: serializeManageExtra(extra) });
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const extra = (await getExtras(auth.pid)).find((e) => e.id === String(params.id ?? ""));
  if (!extra) return apiError(404, "not_found", "No extra with that id.");

  if (request.method === "DELETE") {
    await deleteExtra(auth.pid, extra.id);
    if (extra.image) queueImageCleanup(auth.pid, [extra.image]);
    return Response.json({ deleted: true });
  }

  if (request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "bad_request", "Body must be JSON.");
    }
    const parsed = validateExtraInput(body, { create: false, ...(await catalogIds(auth.pid)) });
    if (!parsed.ok) return validationError(parsed.errors);
    const next = buildExtra(parsed.value, extra);
    await saveExtra(auth.pid, next);
    if (extra.image && extra.image !== next.image) queueImageCleanup(auth.pid, [extra.image]);
    return Response.json({ data: serializeManageExtra(next) });
  }

  return apiError(405, "method_not_allowed", "Use PATCH to edit or DELETE to remove.");
}
