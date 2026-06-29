import type { Route } from "./+types/api.v1.extras";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { getActiveExtras } from "~/lib/extras.server";
import { serializeExtra } from "~/lib/api-serialize";

// GET /v1/extras — the active "enhance your stay" catalog.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  const extras = await getActiveExtras(auth.pid);
  return Response.json({ data: extras.map(serializeExtra) });
}
