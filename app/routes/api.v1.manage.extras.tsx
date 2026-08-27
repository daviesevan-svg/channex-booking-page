import type { Route } from "./+types/api.v1.manage.extras";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { getExtras } from "~/lib/extras.server";
import { serializeManageExtra } from "~/lib/manage-serialize";

// GET /v1/manage/extras — every extra, active or not, with exclusions.
// Deliberately getExtras, NOT the admin page's ensureExampleExtras seeding:
// an API caller listing a fresh property gets the real (possibly empty)
// catalog, not demo content.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const extras = await getExtras(auth.pid);
  return Response.json({ data: extras.map(serializeManageExtra) });
}
