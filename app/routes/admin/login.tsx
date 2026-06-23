import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/login";
import {
  createMagicToken,
  getAdminEmail,
  isAllowedEmail,
  sendMagicLink,
} from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";

export async function loader({ request }: Route.LoaderArgs) {
  if (await getAdminEmail(request)) throw redirect("/admin");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: "Enter your email address." };
  if (!isAllowedEmail(email)) {
    return { error: "That email isn't on the admin allowlist." };
  }
  const token = await createMagicToken(email);
  const { appUrl } = getConfig();
  const link = `${appUrl}/admin/verify?token=${encodeURIComponent(token)}`;
  const result = await sendMagicLink(email, link);
  return { ok: true, sent: result.sent, devLink: result.link };
}

export function meta() {
  return [{ title: "Admin · Sign in" }];
}

export default function Login({ actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const sending = nav.state === "submitting";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-6 flex items-center gap-3">
        <span
          className="inline-block h-3.5 w-3.5 rounded-[2px] bg-accent"
          style={{ transform: "rotate(45deg)" }}
        />
        <span className="font-serif text-[22px] font-semibold">Booking Admin</span>
      </div>

      {actionData?.ok ? (
        <div className="rounded-[14px] border border-line bg-surface p-6">
          <h1 className="mb-2 font-serif text-[22px] font-semibold">Check your email</h1>
          <p className="text-[15px] text-secondary">
            {actionData.sent
              ? "We've emailed you a sign-in link. It expires in 15 minutes."
              : "Email isn't configured in this environment, so use the link below:"}
          </p>
          {actionData.devLink && (
            <a
              href={actionData.devLink}
              className="mt-4 block break-all rounded-[10px] bg-accent-soft px-4 py-3 text-[13px] font-semibold text-accent-deep"
            >
              {actionData.devLink}
            </a>
          )}
        </div>
      ) : (
        <Form method="post" className="rounded-[14px] border border-line bg-surface p-6">
          <h1 className="mb-1 font-serif text-[24px] font-semibold">Sign in</h1>
          <p className="mb-5 text-[14px] text-muted">We'll email you a magic link — no password.</p>
          <label className="block text-[13px] font-semibold text-secondary">
            Email
            <input
              name="email"
              type="email"
              required
              autoFocus
              placeholder="you@example.com"
              className="mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[13px] text-[15px] text-ink outline-none focus:border-accent"
            />
          </label>
          {actionData?.error && (
            <p className="mt-2 text-[13px] text-red-600">{actionData.error}</p>
          )}
          <button
            type="submit"
            disabled={sending}
            className="mt-5 w-full rounded-[10px] bg-accent py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {sending ? "Sending…" : "Send magic link"}
          </button>
        </Form>
      )}
    </main>
  );
}
