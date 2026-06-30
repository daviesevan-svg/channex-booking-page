import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/login";
import {
  canSignIn,
  createAdminSession,
  getAdminEmail,
  requestLoginCode,
  verifyLoginCode,
} from "~/lib/auth.server";

export async function loader({ request }: Route.LoaderArgs) {
  if (await getAdminEmail(request)) throw redirect("/admin");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: "Enter your email address." };
  if (!(await canSignIn(email))) {
    return { error: "That email isn't on the admin allowlist." };
  }

  // Step 2: a code was entered — verify it and sign in (unless resending).
  const code = String(form.get("code") ?? "").trim();
  const resend = form.get("resend") != null;
  if (code && !resend) {
    const r = await verifyLoginCode(email, code);
    if (r.ok) return createAdminSession(email, "/admin");
    return {
      step: "code" as const,
      email,
      error:
        r.reason === "locked"
          ? "Too many attempts. Request a new code."
          : r.reason === "expired"
            ? "That code has expired. Request a new one."
            : "That code isn't right. Try again.",
    };
  }

  // Step 1 (or resend): generate + send a code.
  const { sent } = await requestLoginCode(email);
  return { step: "code" as const, email, sent };
}

export function meta() {
  return [{ title: "Admin · Sign in" }];
}

const INPUT =
  "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[13px] text-[15px] text-ink outline-none focus:border-accent";

export default function Login({ actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const onCodeStep = actionData?.step === "code";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-6 flex items-center gap-3">
        <span
          className="inline-block h-3.5 w-3.5 rounded-[2px] bg-accent"
          style={{ transform: "rotate(45deg)" }}
        />
        <span className="font-serif text-[22px] font-semibold">Booking Admin</span>
      </div>

      {onCodeStep ? (
        <Form method="post" className="rounded-[14px] border border-line bg-surface p-6">
          <h1 className="mb-1 font-serif text-[24px] font-semibold">Enter your code</h1>
          <p className="mb-5 text-[14px] text-muted">
            We emailed a 6-digit sign-in code to <strong>{actionData.email}</strong>. It expires in
            10 minutes.
          </p>
          <input type="hidden" name="email" value={actionData.email} />
          <label className="block text-[13px] font-semibold text-secondary">
            Sign-in code
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              autoFocus
              placeholder="123456"
              className={`${INPUT} tracking-[6px]`}
            />
          </label>
          {actionData?.error && <p className="mt-2 text-[13px] text-red-600">{actionData.error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-[10px] bg-accent py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {busy ? "Verifying…" : "Sign in"}
          </button>
          <p className="mt-3 text-center text-[12.5px] text-muted">
            Didn't get it?{" "}
            <button type="submit" name="resend" value="1" className="font-semibold text-accent hover:underline">
              Resend code
            </button>
          </p>
        </Form>
      ) : (
        <Form method="post" className="rounded-[14px] border border-line bg-surface p-6">
          <h1 className="mb-1 font-serif text-[24px] font-semibold">Sign in</h1>
          <p className="mb-5 text-[14px] text-muted">We'll email you a sign-in code — no password.</p>
          <label className="block text-[13px] font-semibold text-secondary">
            Email
            <input
              name="email"
              type="email"
              required
              autoFocus
              placeholder="you@example.com"
              className={INPUT}
            />
          </label>
          {actionData?.error && <p className="mt-2 text-[13px] text-red-600">{actionData.error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-[10px] bg-accent py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {busy ? "Sending…" : "Email me a code"}
          </button>
        </Form>
      )}
    </main>
  );
}
