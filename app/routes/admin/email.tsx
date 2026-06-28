import { useRef, useState } from "react";
import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/email";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { emailDef, langParam, pickLang } from "~/lib/content";
import { getEmailOverridesRaw, getEmailTemplate, getOverrides, getSettings, saveEmailContent } from "~/lib/overrides.server";
import { accentHex, bookingVars, composeEmail, sampleBooking } from "~/lib/email-render.server";
import { sendEmail } from "~/lib/email.server";
import { FIELD_INPUT } from "~/components/admin-form";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const def = emailDef(params.template);
  if (!def) throw redirect("/admin/emails");
  const pid = await currentPropertyId(request);
  const lang = langParam(request);
  if (!pid) {
    return { configured: false as const, label: def.label, template: params.template, lang };
  }

  const [overrides, settings, ov, text] = await Promise.all([
    getEmailOverridesRaw(pid, params.template, lang),
    getSettings(pid),
    getOverrides(pid, lang),
    getEmailTemplate(pid, params.template, lang),
  ]);
  const hotelName = ov.hotelName || "Your hotel";
  const sample = sampleBooking(settings.currency || "GBP");
  const manageUrl = `${new URL(request.url).origin}/${pid}/manage/${sample.id}`;
  const { subject, html } = composeEmail({ def, text, booking: sample, hotelName, accent: accentHex(settings), manageUrl });

  // Example value per token, for the "variables" reference table.
  const vars = bookingVars(sample, hotelName, manageUrl);
  const tokens = def.tokens.map((t) => ({
    token: t.token,
    desc: t.desc,
    example: vars[t.token.replace(/[{}]/g, "")] ?? "",
  }));

  return {
    configured: true as const,
    label: def.label,
    recipient: def.recipient,
    template: params.template,
    fields: def.fields,
    overrides,
    tokens,
    lang,
    previewSubject: subject,
    previewHtml: html,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const adminEmail = await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { error: "No property selected." };
  const def = emailDef(params.template);
  if (!def) return { error: "Unknown template." };
  const form = await request.formData();
  const lang = pickLang(String(form.get("lang") ?? ""));

  if (String(form.get("intent")) === "test") {
    const [settings, ov, text] = await Promise.all([
      getSettings(pid),
      getOverrides(pid, lang),
      getEmailTemplate(pid, params.template, lang),
    ]);
    const sample = sampleBooking(settings.currency || "GBP");
    const manageUrl = `${new URL(request.url).origin}/${pid}/manage/${sample.id}`;
    const { subject, html } = composeEmail({
      def,
      text,
      booking: sample,
      hotelName: ov.hotelName || "Your hotel",
      accent: accentHex(settings),
      manageUrl,
    });
    const { sent } = await sendEmail({ to: adminEmail, subject, html, replyTo: settings.emailReplyTo });
    return sent
      ? { ok: true as const, message: `Test sent to ${adminEmail}.` }
      : { ok: true as const, message: "No email provider configured — see server logs for the composed test." };
  }

  await saveEmailContent(pid, params.template, lang, Object.fromEntries(form));
  return { ok: true as const, message: "Saved." };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Admin · ${loaderData?.label ?? "Email"}` }];
}

export default function AdminEmail({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const formRef = useRef<HTMLFormElement>(null);
  const [copied, setCopied] = useState(false);

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{loaderData.label}</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to edit email templates.
        </p>
      </div>
    );
  }

  const { label, recipient, fields, overrides, tokens, lang, previewSubject, previewHtml } = loaderData;

  // Build a paste-ready brief from the live field values for AI editing.
  const copyBrief = async () => {
    const f = formRef.current;
    if (!f) return;
    const val = (name: string) => (f.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";
    const tokenLines = tokens.map((t) => `  ${t.token} — ${t.desc}`).join("\n");
    const brief = [
      `You are editing the "${label}" email template for a hotel booking system. Rewrite ONLY the copy.`,
      ``,
      `Rules:`,
      `- Keep any {tokens} you want — they are replaced with real values when the email is sent. Available tokens:`,
      tokenLines,
      `- Do NOT invent new tokens; unknown ones appear literally in the email.`,
      `- Plain text only — no HTML. Line breaks are preserved.`,
      `- The booking details (rooms, dates, prices, amount due, ${recipient === "guest" ? "manage-booking link" : "guest contact details"}) are inserted automatically between the intro and outro — do not recreate them.`,
      ``,
      `Current template:`,
      `SUBJECT: ${val("subject")}`,
      `HEADING: ${val("heading")}`,
      `INTRO: ${val("intro")}`,
      `OUTRO: ${val("outro")}`,
      ``,
      `Return the updated SUBJECT, HEADING, INTRO and OUTRO.`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(brief);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="font-serif text-[26px] font-semibold">{label} email</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ {actionData.message}
          </span>
        )}
      </div>
      <p className="mb-5 text-[14px] text-muted">
        Edit the wording guests {recipient === "host" ? "and you" : ""} see. The booking details block is added
        automatically — you only write the surrounding text. Empty fields use the defaults shown.
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <Form
            ref={formRef}
            method="post"
            key={loaderData.template + lang}
            className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
          >
            <input type="hidden" name="lang" value={lang} />
            <input type="hidden" name="intent" value="save" />
            {fields.map((f) => (
              <label key={f.key} className="block text-[13px] font-semibold text-secondary">
                {f.label}
                {f.textarea ? (
                  <textarea name={f.key} rows={4} defaultValue={overrides[f.key]} placeholder={f.default} className={`${FIELD_INPUT} resize-y`} />
                ) : (
                  <input name={f.key} defaultValue={overrides[f.key]} placeholder={f.default} className={FIELD_INPUT} />
                )}
              </label>
            ))}
            {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" disabled={saving} className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60">
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button type="button" onClick={copyBrief} className="rounded-[10px] border border-line-alt px-4 py-3 text-[14px] font-semibold text-ink hover:border-accent hover:text-accent">
                {copied ? "Copied ✓" : "Copy AI editing brief"}
              </button>
            </div>
          </Form>

          {/* Send a test of the saved template to yourself. */}
          <Form method="post" className="mt-3 flex items-center gap-3">
            <input type="hidden" name="lang" value={lang} />
            <input type="hidden" name="intent" value="test" />
            <button type="submit" disabled={saving} className="rounded-[10px] border border-line-alt px-4 py-2.5 text-[13px] font-semibold text-muted hover:border-accent hover:text-accent disabled:opacity-60">
              Send test to me
            </button>
            <span className="text-[12px] text-faint">Sends the saved version with sample booking data.</span>
          </Form>

          <div className="mt-5 rounded-[14px] border border-line bg-surface p-5">
            <h2 className="mb-1 text-[14px] font-semibold text-ink">Variables you can use</h2>
            <p className="mb-3 text-[12px] text-muted">
              Type these anywhere in the fields. They're swapped for the real booking values when the email sends.
            </p>
            <table className="w-full text-[13px]">
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.token} className="border-t border-divider/60 align-top">
                    <td className="py-1.5 pr-3 font-mono text-[12px] text-accent-deep">{t.token}</td>
                    <td className="py-1.5 pr-3 text-secondary">{t.desc}</td>
                    <td className="py-1.5 text-faint">{t.example}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="mb-2 text-[13px] font-semibold text-secondary">Preview (saved version)</div>
          <div className="mb-2 rounded-[10px] border border-line bg-surface-alt px-3 py-2 text-[13px]">
            <span className="text-faint">Subject: </span>
            <span className="font-semibold text-ink">{previewSubject}</span>
          </div>
          <iframe
            title="Email preview"
            srcDoc={previewHtml}
            sandbox=""
            className="h-[640px] w-full rounded-[12px] border border-line bg-white"
          />
        </div>
      </div>
    </div>
  );
}
