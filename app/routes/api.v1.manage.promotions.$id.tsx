import type { Route } from "./+types/api.v1.manage.promotions.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { serializeManagePromotion } from "~/lib/manage-serialize";
import { promotionCrossFieldErrors, validatePromotionInput, validationError } from "~/lib/manage-validate";
import { deletePromotion, getPromotions, savePromotion } from "~/lib/promotions.server";
import { buildPromotion } from "./api.v1.manage.promotions";

// GET /v1/manage/promotions/:id · PATCH (sparse merge; cross-field rules on
// the merged record) · DELETE.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const promo = (await getPromotions(auth.pid)).find((p) => p.id === String(params.id ?? ""));
  if (!promo) return apiError(404, "not_found", "No promotion with that id.");
  return Response.json({ data: serializeManagePromotion(promo) });
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const promos = await getPromotions(auth.pid);
  const promo = promos.find((p) => p.id === String(params.id ?? ""));
  if (!promo) return apiError(404, "not_found", "No promotion with that id.");

  if (request.method === "DELETE") {
    await deletePromotion(auth.pid, promo.id);
    await queueGoogleAriPush(auth.pid, ["promotions"]);
    return Response.json({ deleted: true });
  }

  if (request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "bad_request", "Body must be JSON.");
    }
    const parsed = validatePromotionInput(body, { create: false });
    if (!parsed.ok) return validationError(parsed.errors);
    const next = buildPromotion(parsed.value, { ...promo, trigger: promo.trigger ?? "code" });
    const crossErrors = promotionCrossFieldErrors(next);
    if (crossErrors) return validationError(crossErrors);
    if (next.trigger === "code" && promos.some((p) => p.id !== next.id && p.code === next.code)) {
      return validationError({ code: [`"${next.code}" is already used by another promotion.`] });
    }
    await savePromotion(auth.pid, next);
    await queueGoogleAriPush(auth.pid, ["promotions"]);
    return Response.json({ data: serializeManagePromotion(next) });
  }

  return apiError(405, "method_not_allowed", "Use PATCH to edit or DELETE to remove.");
}
