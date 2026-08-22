import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/login";
import { adminMeta } from "~/lib/admin-meta";
import {
  ADMIN_LOGIN_LIMIT,
  ADMIN_LOGIN_WINDOW_SEC,
  adminLoginPublicResult,
  shouldSendAdminMagicLink,
} from "~/lib/admin-login";
import {
  adminHostPartnerId,
  canSignInOnHost,
  createMagicToken,
  getAdminEmail,
  sendMagicLink,
} from "~/lib/auth.server";
import { adminLangFromRequest, adminT } from "~/lib/admin-i18n";
import { getPartner } from "~/lib/partners.server";
import { clientKey, rateLimit } from "~/lib/rate-limit.server";

export async function loader({ request }: Route.LoaderArgs) {
  // Our hosts and registered partner admin hosts only — anything else 404s. A
  // hotel's custom domain must never render this form (a phishing surface),
  // and adminHostPartnerId is what enforces that now.
  const hostPartnerId = await adminHostPartnerId(request);
  if (await getAdminEmail(request)) throw redirect("/admin");
  // A team invite links here with ?email= so the invitee's address is pre-filled.
  const email = new URL(request.url).searchParams.get("email") ?? "";
  // Pre-login branding: on a partner's admin host the form carries THEIR name
  // and logo — the first thing an invited hotel ever sees.
  const partner = hostPartnerId ? await getPartner(hostPartnerId) : undefined;
  return {
    email,
    adminLang: adminLangFromRequest(request),
    brandName: partner?.brandName ?? null,
    brandLogo: partner?.logoImage ?? null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const hostPartnerId = await adminHostPartnerId(request);
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email) return adminLoginPublicResult({ hasEmail: false, allowed: false, throttled: false });

  // Count every attempt — unknown emails included — so the per-email bucket
  // cannot confirm who is on the allowlist, and a single IP cannot spray
  // operators. Fail-open/racy KV is the same blunt throttle as web checkout.
  const ipOk = await rateLimit(`adminlogin:ip:${clientKey(request)}`, ADMIN_LOGIN_LIMIT, ADMIN_LOGIN_WINDOW_SEC);
  const emailOk = await rateLimit(`adminlogin:email:${email}`, ADMIN_LOGIN_LIMIT, ADMIN_LOGIN_WINDOW_SEC);
  const throttled = !ipOk || !emailOk;

  // Host-scoped in both directions: partner hosts are invite-only for that
  // partner's users; a partner's users don't get OUR door once theirs exists.
  // Unknown emails still get the check-email copy; we just don't send.
  const allowed = !throttled && (await canSignInOnHost(email, hostPartnerId));
  if (shouldSendAdminMagicLink(allowed, throttled)) {
    const token = await createMagicToken(email);
    // Build the link from this request's own origin so it works on any host.
    const origin = new URL(request.url).origin;
    const link = `${origin}/admin/verify?token=${encodeURIComponent(token)}`;
    await sendMagicLink(email, link);
  }
  return adminLoginPublicResult({ hasEmail: true, allowed, throttled });
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "mtSignIn" });
}

export default function Login({ actionData, loaderData }: Route.ComponentProps) {
  const nav = useNavigation();
  const sending = nav.state === "submitting";
  const t = adminT(loaderData.adminLang);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-6 flex items-center gap-3">
        {loaderData.brandLogo ? (
          <img src={loaderData.brandLogo} alt="" className="h-8 max-w-[180px] object-contain" />
        ) : (
          <span
            className="inline-block h-3.5 w-3.5 rounded-[2px] bg-accent"
            style={{ transform: "rotate(45deg)" }}
          />
        )}
        <span className="font-serif text-[22px] font-semibold">{loaderData.brandName ?? "Booking Admin"}</span>
      </div>

      {actionData?.ok ? (
        <div className="rounded-[14px] border border-line bg-surface p-6">
          <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("loginCheckEmail")}</h1>
          <p className="text-[15px] text-secondary">{t("loginLinkSent")}</p>
        </div>
      ) : (
        <Form method="post" className="rounded-[14px] border border-line bg-surface p-6">
          <h1 className="mb-1 font-serif text-[24px] font-semibold">{t("loginTitle")}</h1>
          <p className="mb-5 text-[14px] text-muted">{t("loginIntro")}</p>
          <label className="block text-[13px] font-semibold text-secondary">
            {t("loginEmail")}
            <input
              name="email"
              type="email"
              required
              autoFocus
              defaultValue={loaderData?.email ?? ""}
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
            {sending ? t("loginSending") : t("loginSend")}
          </button>
        </Form>
      )}
    </main>
  );
}
