import type { Route } from "./+types/api.v1.manage.taxes";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { serializeTaxConfig } from "~/lib/manage-serialize";
import { getSettings } from "~/lib/overrides.server";

// GET /v1/manage/taxes — the whole tax/fee/city-tax document.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  return Response.json({ data: serializeTaxConfig(await getSettings(auth.pid)) });
}
