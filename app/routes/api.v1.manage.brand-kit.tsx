import type { Route } from "./+types/api.v1.manage.brand-kit";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { buildBrandKit } from "~/lib/brand-kit.server";

// GET /v1/manage/brand-kit — the derived brand kit (AI copy brief, brand.css,
// tokens.json). Pure read, nothing stored: exactly what the admin page
// exports, so an agent building a matching marketing site starts from the
// same tokens the booking pages actually use.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  return Response.json({ data: await buildBrandKit(auth.pid) });
}
