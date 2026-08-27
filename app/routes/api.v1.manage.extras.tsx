import type { Route } from "./+types/api.v1.manage.extras";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import type { Extra } from "~/lib/extras";
import { getExtras, saveExtra } from "~/lib/extras.server";
import { catalogIds } from "~/lib/manage-catalog.server";
import { serializeManageExtra } from "~/lib/manage-serialize";
import { validateExtraInput, validationError, type ExtraInput } from "~/lib/manage-validate";

// GET  /v1/manage/extras — every extra, active or not, with exclusions.
//      Deliberately getExtras, NOT the admin page's ensureExampleExtras
//      seeding: an API caller listing a fresh property gets the real
//      (possibly empty) catalog, not demo content.
// POST /v1/manage/extras — create an add-on.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const extras = await getExtras(auth.pid);
  return Response.json({ data: extras.map(serializeManageExtra) });
}

export function buildExtra(input: ExtraInput, base: Extra): Extra {
  return {
    ...base,
    name: input.name ?? base.name,
    desc: input.desc === undefined ? base.desc : (input.desc ?? undefined),
    image: input.image === undefined ? base.image : (input.image ?? undefined),
    unit: input.unit ?? base.unit,
    price: input.price === undefined ? base.price : (input.price ?? undefined),
    options: input.options ?? base.options,
    fields: input.fields ?? base.fields,
    infoTitle: input.infoTitle === undefined ? base.infoTitle : (input.infoTitle ?? undefined),
    scope: input.scope ?? base.scope,
    taxable: input.taxable ?? base.taxable,
    excludeRooms: input.excludeRooms ?? base.excludeRooms,
    excludeRates: input.excludeRates ?? base.excludeRates,
    active: input.active ?? base.active,
    position: input.position ?? base.position,
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
  const parsed = validateExtraInput(body, { create: true, ...(await catalogIds(auth.pid)) });
  if (!parsed.ok) return validationError(parsed.errors);
  const extras = await getExtras(auth.pid);
  const extra = buildExtra(parsed.value, {
    id: crypto.randomUUID(),
    name: "",
    unit: "stay",
    active: parsed.value.active ?? true,
    position: extras.length,
    createdAt: new Date().toISOString(),
  });
  await saveExtra(auth.pid, extra);
  return Response.json({ data: serializeManageExtra(extra) }, { status: 201 });
}
