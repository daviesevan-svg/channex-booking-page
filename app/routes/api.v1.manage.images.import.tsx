import type { Route } from "./+types/api.v1.manage.images.import";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { importManageImage } from "~/lib/images.server";

// POST /v1/manage/images/import — { url } fetches a PUBLIC https image and
// stores it like an upload, returning the /images/… path. This is what lets
// an MCP agent do photos (files can't travel over JSON-RPC): the SSRF gate is
// the webhook one — https only, no localhost/internal names/private IPs —
// re-checked on every redirect hop, plus the upload rules (image/*, 8MB).
export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "POST { url } of a public https image.");
  let body: { url?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  if (typeof body.url !== "string" || !body.url.trim()) return apiError(422, "validation_error", "`url` is required.");
  try {
    const url = await importManageImage(auth.pid, body.url.trim());
    return Response.json({ data: { url } }, { status: 201 });
  } catch (e) {
    return apiError(422, "validation_error", e instanceof Error ? e.message : "Import failed.");
  }
}
