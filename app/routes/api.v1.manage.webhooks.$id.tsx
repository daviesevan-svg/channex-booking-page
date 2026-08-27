import type { Route } from "./+types/api.v1.manage.webhooks.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { listWebhooks, removeWebhook } from "~/lib/webhooks.server";

// DELETE /v1/manage/webhooks/:id — remove an endpoint. Deliveries stop
// immediately; there is no update verb (create a new endpoint instead — a new
// secret with every URL is the point).
export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "DELETE") return apiError(405, "method_not_allowed", "Use DELETE.");
  const id = String(params.id ?? "");
  const exists = (await listWebhooks(auth.pid)).some((h) => h.id === id);
  if (!exists) return apiError(404, "not_found", "No webhook with that id.");
  await removeWebhook(auth.pid, id);
  return Response.json({ deleted: true });
}
