import type { Route } from "./+types/api.v1.rates";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { getRates } from "~/lib/catalog.server";
import { serializeRate } from "~/lib/api-serialize";

// GET /v1/rates — rate-plan definitions + policies (base prices by room id).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  const rates = await getRates(auth.pid);
  return Response.json({ data: rates.filter((r) => r.active).map(serializeRate) });
}
