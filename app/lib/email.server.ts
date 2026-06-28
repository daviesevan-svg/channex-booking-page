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
import type { BookingRecord } from "./bookings.server";
import { emailDef, type SiteSettings } from "./content";
import { getConfig, type AppConfig } from "./config.server";
import { accentHex, composeEmail } from "./email-render.server";
import { getEmailTemplate, getOverrides, getSettings } from "./overrides.server";

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

// ---------- high-level booking emails ----------
// The sending domain is global (RESEND_FROM); the property only overrides the
// display name. Falls back to RESEND_FROM / the dev sender.
function senderFrom(settings: SiteSettings, config: AppConfig): string | undefined {
  const base = config.resendFrom;
  if (!base || !settings.emailFromName) return base;
  const addr = base.match(/<([^>]+)>/)?.[1] ?? base;
  return `${settings.emailFromName} <${addr}>`;
}

/** Guest booking confirmation + (opt-in) host new-booking notification. Never
 *  throws — a mail failure must never break the booking flow. */
export async function sendBookingEmails(pid: string, booking: BookingRecord, origin: string): Promise<void> {
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid, booking.lang)]);
    const hotelName = ov.hotelName || "Your hotel";
    const accent = accentHex(settings);
    const from = senderFrom(settings, getConfig());
    const manageUrl = `${origin}/${pid}/manage/${booking.id}`;

    const gtext = await getEmailTemplate(pid, "booking_confirmation", booking.lang);
    const g = composeEmail({ def: emailDef("booking_confirmation")!, text: gtext, booking, hotelName, accent, manageUrl });
    await sendEmail({ to: booking.guest.email, subject: g.subject, html: g.html, from, replyTo: settings.emailReplyTo });

    const hostTo = settings.hostNotifyEmail || ov.email;
    if (settings.notifyHostOnBooking !== false && hostTo) {
      const htext = await getEmailTemplate(pid, "host_notification", booking.lang);
      const h = composeEmail({ def: emailDef("host_notification")!, text: htext, booking, hotelName, accent, manageUrl });
      await sendEmail({ to: hostTo, subject: h.subject, html: h.html, from, replyTo: booking.guest.email });
    }
  } catch (e) {
    console.log(`[email] sendBookingEmails failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Guest cancellation confirmation + (opt-in) host cancellation notification. */
export async function sendCancellationEmails(pid: string, booking: BookingRecord, origin: string): Promise<void> {
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid, booking.lang)]);
    const hotelName = ov.hotelName || "Your hotel";
    const accent = accentHex(settings);
    const from = senderFrom(settings, getConfig());
    const manageUrl = `${origin}/${pid}/manage/${booking.id}`;

    const gtext = await getEmailTemplate(pid, "booking_cancellation", booking.lang);
    const g = composeEmail({ def: emailDef("booking_cancellation")!, text: gtext, booking, hotelName, accent, manageUrl });
    await sendEmail({ to: booking.guest.email, subject: g.subject, html: g.html, from, replyTo: settings.emailReplyTo });

    const hostTo = settings.hostNotifyEmail || ov.email;
    if (settings.notifyHostOnCancel !== false && hostTo) {
      const htext = await getEmailTemplate(pid, "cancellation_notification", booking.lang);
      const h = composeEmail({ def: emailDef("cancellation_notification")!, text: htext, booking, hotelName, accent, manageUrl });
      await sendEmail({ to: hostTo, subject: h.subject, html: h.html, from, replyTo: booking.guest.email });
    }
  } catch (e) {
    console.log(`[email] sendCancellationEmails failed: ${e instanceof Error ? e.message : e}`);
  }
}
