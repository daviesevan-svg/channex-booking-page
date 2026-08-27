import type { Route } from "./+types/api.v1.manage.promotions";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { serializeManagePromotion } from "~/lib/manage-serialize";
import { getPromotions } from "~/lib/promotions.server";

// GET /v1/manage/promotions — promo codes and automatic offers.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const promos = await getPromotions(auth.pid);
  return Response.json({ data: promos.map(serializeManagePromotion) });
}
