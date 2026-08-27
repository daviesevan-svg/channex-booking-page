import type { Route } from "./+types/api.v1.manage.rates";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { getRates, getRooms, pricingModeOf, replaceRates, saveRate, type CatalogRate } from "~/lib/catalog.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { serializeManageRate } from "~/lib/manage-serialize";
import { applyPolicyMirrors, validateRateInput, validationError, type RateInput } from "~/lib/manage-validate";
import { getSettings } from "~/lib/overrides.server";

// GET  /v1/manage/rates — full structural rate-plan records.
// POST /v1/manage/rates — create a rate plan (policy required — no implicit
//      default policy; an agent must say what it's promising guests).
// PUT  /v1/manage/rates — replace the whole list in one write. Retained ids
//      keep their server-owned fields (channexRateIds, legacy perPerson,
//      createdAt) — a re-import must never sever the Channex mapping.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const [rates, settings] = await Promise.all([getRates(auth.pid), getSettings(auth.pid)]);
  return Response.json({
    data: rates.map(serializeManageRate),
    pricing_mode: pricingModeOf(settings, rates),
  });
}

export function buildRate(input: RateInput, base: CatalogRate): CatalogRate {
  let next: CatalogRate = {
    ...base,
    title: input.title ?? base.title,
    mealPlan: input.mealPlan === undefined ? base.mealPlan : (input.mealPlan ?? undefined),
    active: input.active ?? base.active,
    prices: input.prices ?? base.prices,
    occupancyPricing: input.occupancyPricing === undefined ? base.occupancyPricing : (input.occupancyPricing ?? undefined),
    occupancyPricingByRoom:
      input.occupancyPricingByRoom === undefined
        ? base.occupancyPricingByRoom
        : input.occupancyPricingByRoom && Object.keys(input.occupancyPricingByRoom).length
          ? input.occupancyPricingByRoom
          : undefined,
    inclusions: input.inclusions ?? base.inclusions,
  };
  if (input.policy) next = applyPolicyMirrors(next, input.policy);
  return next;
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const roomIds = new Set((await getRooms(auth.pid)).map((r) => r.id));

  if (request.method === "POST") {
    const parsed = validateRateInput(body, { create: true, roomIds });
    if (!parsed.ok) return validationError(parsed.errors);
    const rate = buildRate(parsed.value, {
      id: crypto.randomUUID(),
      title: "",
      prices: {},
      refundable: true,
      inclusions: [],
      active: parsed.value.active ?? true,
      createdAt: new Date().toISOString(),
    });
    await saveRate(auth.pid, rate);
    await queueGoogleAriPush(auth.pid, ["property_data", "ari"]);
    return Response.json({ data: serializeManageRate(rate) }, { status: 201 });
  }

  if (request.method === "PUT") {
    if (!Array.isArray(body)) return apiError(422, "validation_error", "PUT takes a JSON array of rate plans (the full list).");
    const existing = await getRates(auth.pid);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const next: CatalogRate[] = [];
    for (let i = 0; i < body.length; i++) {
      const item = body[i] as Record<string, unknown>;
      const id = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : crypto.randomUUID();
      const { id: _id, ...rest } = (item ?? {}) as Record<string, unknown>;
      const parsed = validateRateInput(rest, { create: true, roomIds });
      if (!parsed.ok) return validationError(Object.fromEntries(Object.entries(parsed.errors).map(([k, v]) => [`[${i}].${k}`, v])));
      const base = byId.get(id);
      next.push(
        buildRate(parsed.value, {
          id,
          title: "",
          prices: {},
          refundable: true,
          inclusions: [],
          active: parsed.value.active ?? true,
          createdAt: base?.createdAt ?? new Date().toISOString(),
          // Server-owned fields survive a full replace for retained ids.
          channexRateIds: base?.channexRateIds,
          perPerson: base?.perPerson,
        }),
      );
    }
    await replaceRates(auth.pid, next);
    await queueGoogleAriPush(auth.pid, ["property_data", "ari"]);
    return Response.json({ data: next.map(serializeManageRate) });
  }

  return apiError(405, "method_not_allowed", "Use POST to create or PUT to replace the list.");
}
