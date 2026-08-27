import type { Route } from "./+types/api.v1.manage.rates";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { getRates, pricingModeOf } from "~/lib/catalog.server";
import { serializeManageRate } from "~/lib/manage-serialize";
import { getSettings } from "~/lib/overrides.server";

// GET /v1/manage/rates — full structural rate-plan records (incl. inactive
// ones — an admin surface shows everything), plus the property-wide pricing
// mode the per-occupancy rules hang off.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const [rates, settings] = await Promise.all([getRates(auth.pid), getSettings(auth.pid)]);
  return Response.json({
    data: rates.map(serializeManageRate),
    pricing_mode: pricingModeOf(settings, rates),
  });
}
