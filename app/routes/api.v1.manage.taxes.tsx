import type { Route } from "./+types/api.v1.manage.taxes";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { serializeTaxConfig } from "~/lib/manage-serialize";
import { validateTaxDocument, validationError } from "~/lib/manage-validate";
import { getSettings, patchSettings } from "~/lib/overrides.server";

// GET /v1/manage/taxes — the whole tax/fee/city-tax document.
// PUT /v1/manage/taxes — replace it (it is one settings write; PUT is honest).
//     Unlike the admin form, invalid rows are 422s, never silently dropped.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  return Response.json({ data: serializeTaxConfig(await getSettings(auth.pid)) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PUT") return apiError(405, "method_not_allowed", "Use PUT with the full tax document.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const parsed = validateTaxDocument(body);
  if (!parsed.ok) return validationError(parsed.errors);
  const { taxesInclusive, taxes, fees, cityTax } = parsed.value;
  const settings = await patchSettings(auth.pid, { taxesInclusive, taxes, fees, cityTax: cityTax ?? (null as never) });
  await queueGoogleAriPush(auth.pid, ["taxes"]);
  return Response.json({ data: serializeTaxConfig(settings) });
}
