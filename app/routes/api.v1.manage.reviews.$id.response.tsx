import type { Route } from "./+types/api.v1.manage.reviews.$id.response";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { setReviewResponse } from "~/lib/reviews.server";

// POST /v1/manage/reviews/:bookingId/response — set (or clear, with null/"")
// the hotel's public reply. The ONLY write on reviews: the guest's text is
// never writable, and there is no hide/delete — a property responds to
// criticism, it can't bury it.
export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "Use POST with { text } (null or empty clears the response).");
  let body: { text?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  if (body.text !== null && body.text !== undefined && typeof body.text !== "string") {
    return apiError(422, "validation_error", "`text` must be a string (or null to clear the response).");
  }
  const updated = await setReviewResponse(auth.pid, String(params.id ?? ""), typeof body.text === "string" ? body.text : "", "api");
  if (!updated) return apiError(404, "not_found", "No review for that booking id.");
  return Response.json({ data: { booking_id: updated.bookingId, response: updated.response ? { text: updated.response.text, at: updated.response.at } : null } });
}
