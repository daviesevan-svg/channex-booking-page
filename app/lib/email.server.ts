// Transactional email delivery via Resend (https://resend.com).
//
// `sendEmail` is the single low-level send used by everything: the admin
// magic-link (auth.server) and the guest/host booking emails. When no
// RESEND_API_KEY is configured (local dev), it logs a one-line summary and
// reports `{ sent: false }` so flows still work without real mail. It never
// throws — a mail failure must never break a booking or sign-in.
//
// PROD: real delivery needs a Resend-verified sending domain. The default
// `onboarding@resend.dev` only delivers to the Resend account owner; set
// RESEND_FROM to "Your Hotel <noreply@your-verified-domain>" for production.
import { getConfig } from "./config.server";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FALLBACK_FROM = "Bookings <onboarding@resend.dev>";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  /** Overrides the global RESEND_FROM / fallback sender. */
  from?: string;
  replyTo?: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<{ sent: boolean; error?: string }> {
  const { resendApiKey, resendFrom } = getConfig();
  const to = Array.isArray(opts.to) ? opts.to : [opts.to];
  const from = opts.from || resendFrom || FALLBACK_FROM;

  if (!resendApiKey) {
    console.log(`[email] (no RESEND_API_KEY) would send "${opts.subject}" to ${to.join(", ")}`);
    return { sent: false };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: opts.subject,
        html: opts.html,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const error = `Resend responded ${res.status}`;
      console.log(`[email] send failed: ${error} (to ${to.join(", ")})`);
      return { sent: false, error };
    }
    return { sent: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : "send failed";
    console.log(`[email] send threw: ${error} (to ${to.join(", ")})`);
    return { sent: false, error };
  }
}
