import type { Route } from "./+types/api.v1.manage.webhooks";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { WEBHOOK_EVENTS, addWebhook, isSafeWebhookUrl, listWebhooks, type WebhookEvent } from "~/lib/webhooks.server";

// GET  /v1/manage/webhooks — endpoints with MASKED secrets (the secret is
//      returned exactly once, by POST — same rule as API keys).
// POST — { url, events? } (empty/omitted events = all). HTTPS only, and the
//      SSRF gate refuses localhost/internal/private-IP targets.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const hooks = await listWebhooks(auth.pid);
  return Response.json({
    data: hooks.map((h) => ({
      id: h.id,
      url: h.url,
      secret_last4: h.secret.slice(-4),
      events: h.events,
      disabled: h.disabled ?? false,
      created_at: h.createdAt,
    })),
    events: WEBHOOK_EVENTS,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "Use POST with { url, events? }.");
  let body: { url?: unknown; events?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url || !isSafeWebhookUrl(url)) {
    return apiError(422, "validation_error", "`url` must be a public https:// endpoint (localhost, internal names and private IPs are refused).");
  }
  let events: WebhookEvent[] = [];
  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || body.events.some((e) => typeof e !== "string" || !(WEBHOOK_EVENTS as readonly string[]).includes(e))) {
      return apiError(422, "validation_error", `\`events\` must be an array of: ${WEBHOOK_EVENTS.join(", ")} (empty = all).`);
    }
    events = body.events as WebhookEvent[];
  }
  const ep = await addWebhook(auth.pid, url, events);
  return Response.json(
    {
      data: { id: ep.id, url: ep.url, secret: ep.secret, events: ep.events, created_at: ep.createdAt },
      note: "Store the secret now — it is never returned again. Verify deliveries via the Roompanda-Signature header (t=<unix>,v1=HMAC-SHA256(secret, `<t>.<rawBody>`)).",
    },
    { status: 201 },
  );
}
