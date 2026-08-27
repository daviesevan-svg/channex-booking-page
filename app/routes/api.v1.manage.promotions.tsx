import type { Route } from "./+types/api.v1.manage.promotions";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { serializeManagePromotion } from "~/lib/manage-serialize";
import { validatePromotionInput, promotionCrossFieldErrors, validationError, type PromotionInput } from "~/lib/manage-validate";
import type { Promotion } from "~/lib/promotions";
import { getPromotions, savePromotion } from "~/lib/promotions.server";

// GET  /v1/manage/promotions — promo codes and automatic offers.
// POST /v1/manage/promotions — create one. Cross-field rules (code promos
//      need a code, value-adds need inclusions and value 0, public auto
//      offers need a name) are checked on the finished record.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const promos = await getPromotions(auth.pid);
  return Response.json({ data: promos.map(serializeManagePromotion) });
}

export function buildPromotion(input: PromotionInput, base: Promotion): Promotion {
  return {
    ...base,
    trigger: input.trigger ?? base.trigger,
    code: input.code ?? base.code,
    name: input.name === undefined ? base.name : (input.name ?? undefined),
    kind: input.kind ?? base.kind,
    type: input.type ?? base.type,
    value: input.value ?? base.value,
    conditions: input.conditions === undefined ? base.conditions : (input.conditions ?? undefined),
    inclusions: input.inclusions ?? base.inclusions,
    exclusive: input.exclusive ?? base.exclusive,
    enabled: input.enabled ?? base.enabled,
    publish: input.publish ?? base.publish,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "Use POST to create.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const parsed = validatePromotionInput(body, { create: true });
  if (!parsed.ok) return validationError(parsed.errors);
  const promo = buildPromotion(parsed.value, {
    id: crypto.randomUUID(),
    trigger: "code",
    code: "",
    type: parsed.value.type ?? "percent",
    value: parsed.value.value ?? 0,
    enabled: parsed.value.enabled ?? true,
    createdAt: new Date().toISOString(),
  });
  const crossErrors = promotionCrossFieldErrors(promo);
  if (crossErrors) return validationError(crossErrors);
  // A duplicate code would make findPromotionByCode ambiguous.
  if (promo.trigger === "code" && (await getPromotions(auth.pid)).some((p) => p.code === promo.code)) {
    return validationError({ code: [`"${promo.code}" is already used by another promotion.`] });
  }
  await savePromotion(auth.pid, promo);
  await queueGoogleAriPush(auth.pid, ["promotions"]);
  return Response.json({ data: serializeManagePromotion(promo) }, { status: 201 });
}
