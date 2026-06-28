import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/emails";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { EMAIL_TEMPLATES } from "~/lib/content";
import { getOverrides, getSettings, saveEmailSettings } from "~/lib/overrides.server";
import { FIELD_INPUT } from "~/components/admin-form";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { configured: false as const };
  const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid)]);
  return {
    configured: true as const,
    settings: {
      emailFromName: settings.emailFromName ?? "",
      emailReplyTo: settings.emailReplyTo ?? "",
      hostNotifyEmail: settings.hostNotifyEmail ?? "",
      notifyHostOnBooking: settings.notifyHostOnBooking !== false,
      notifyHostOnCancel: settings.notifyHostOnCancel !== false,
    },
    contactEmail: ov.email ?? "",
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { error: "No property selected." };
  await saveEmailSettings(pid, await request.formData());
  return { ok: true as const };
}

export function meta() {
  return [{ title: "Admin · Emails" }];
}

const toggleRow = "flex items-center justify-between gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-3";

export default function AdminEmails({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Emails</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to configure emails.
        </p>
      </div>
    );
  }

  const { settings, contactEmail } = loaderData;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Emails</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">✓ Saved</span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">
        Transactional emails sent to guests and to you. Edit each template's wording below; set who they come from here.
      </p>

      <Form method="post" className="mb-8 flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6">
        <h2 className="text-[15px] font-semibold text-ink">Sender &amp; notifications</h2>
        <label className="block text-[13px] font-semibold text-secondary">
          From name
          <input name="emailFromName" defaultValue={settings.emailFromName} placeholder="Your hotel" className={FIELD_INPUT} />
          <span className="mt-1 block text-[12px] font-normal text-faint">
            Shown as the sender name. The sending domain is configured globally (RESEND_FROM).
          </span>
        </label>
        <label className="block text-[13px] font-semibold text-secondary">
          Reply-to address
          <input name="emailReplyTo" type="email" defaultValue={settings.emailReplyTo} placeholder={contactEmail || "you@hotel.com"} className={FIELD_INPUT} />
          <span className="mt-1 block text-[12px] font-normal text-faint">Where guest replies go.</span>
        </label>
        <label className="block text-[13px] font-semibold text-secondary">
          Host notification address
          <input name="hostNotifyEmail" type="email" defaultValue={settings.hostNotifyEmail} placeholder={contactEmail || "front-desk@hotel.com"} className={FIELD_INPUT} />
          <span className="mt-1 block text-[12px] font-normal text-faint">
            Where new-booking and cancellation alerts are sent{contactEmail ? "" : " (defaults to your property contact email)"}.
          </span>
        </label>

        <label className={toggleRow}>
          <span className="text-[13px] font-semibold text-secondary">Notify me of new bookings</span>
          <input type="checkbox" name="notifyHostOnBooking" defaultChecked={settings.notifyHostOnBooking} className="h-4 w-4 accent-[#bf5a3c]" />
        </label>
        <label className={toggleRow}>
          <span className="text-[13px] font-semibold text-secondary">Notify me of cancellations</span>
          <input type="checkbox" name="notifyHostOnCancel" defaultChecked={settings.notifyHostOnCancel} className="h-4 w-4 accent-[#bf5a3c]" />
        </label>

        <div>
          <button type="submit" disabled={saving} className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60">
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </Form>

      <h2 className="mb-3 text-[15px] font-semibold text-ink">Templates</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {EMAIL_TEMPLATES.map((t) => (
          <Link
            key={t.id}
            to={`/admin/emails/${t.id}`}
            className="flex items-center justify-between rounded-[12px] border border-line bg-surface px-4 py-4 hover:border-accent"
          >
            <span>
              <span className="block text-[14px] font-semibold text-ink">{t.label}</span>
              <span className="text-[12px] text-muted">{t.recipient === "guest" ? "Sent to the guest" : "Sent to you"}</span>
            </span>
            <span className="text-muted-2">›</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
