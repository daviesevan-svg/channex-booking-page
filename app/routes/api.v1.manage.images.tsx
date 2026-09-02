import type { Route } from "./+types/api.v1.manage.images";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { rateLimit } from "~/lib/rate-limit.server";
import { uploadManageApiImage } from "~/lib/images.server";

// POST /v1/manage/images — multipart upload, field name "file". Returns the
// /images/… path to reference from any payload (rooms, extras, …).
//
// Import-by-URL lives at POST /v1/manage/images/import (public https only,
// webhook-grade SSRF gate) — that's the MCP-compatible path for photos. There
// is no DELETE — an image dies by being unreferenced; the GC owns removal.
export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  // Every accepted image is an R2 object nothing may ever reference (and the
  // GC only sweeps urls a save dropped). Tighter than the general write bucket.
  if (!(await rateLimit(`apiimage:${auth.pid}:${auth.keyId}`, 20, 600))) {
    return apiError(429, "rate_limited", "At most 20 image uploads/imports per 10 minutes per key.");
  }
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "POST multipart form data with a `file` field.");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError(400, "bad_request", "Send multipart form data with a `file` field.");
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return apiError(422, "validation_error", "`file` must be a non-empty image file.");
  try {
    const url = await uploadManageApiImage(auth.pid, file);
    return Response.json({ data: { url } }, { status: 201 });
  } catch (e) {
    return apiError(422, "validation_error", e instanceof Error ? e.message : "Upload failed.");
  }
}
