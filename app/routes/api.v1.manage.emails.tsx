import type { Route } from "./+types/api.v1.manage.emails";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { EMAIL_TEMPLATES } from "~/lib/content";
import { getSettings } from "~/lib/overrides.server";

// GET /v1/manage/emails — the template catalog (ids, recipients, editable
// fields, valid {tokens}) + the sender identity currently in settings
// (writable via PATCH /v1/manage/property). There is deliberately no
// send-test endpoint: a real outbound email is a UI action.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const s = await getSettings(auth.pid);
  return Response.json({
    data: {
      templates: EMAIL_TEMPLATES.map((t) => ({
        id: t.id,
        label: t.label,
        recipient: t.recipient,
        fields: t.fields.map((f) => ({ key: f.key, label: f.label, multiline: f.textarea ?? false })),
        tokens: t.tokens.map((tk) => ({ token: tk.token, description: tk.desc })),
      })),
      sender: {
        email_from_name: s.emailFromName ?? null,
        email_reply_to: s.emailReplyTo ?? null,
        host_notify_email: s.hostNotifyEmail ?? null,
        notify_host_on_booking: s.notifyHostOnBooking ?? true,
        notify_host_on_cancel: s.notifyHostOnCancel ?? true,
      },
    },
  });
}
