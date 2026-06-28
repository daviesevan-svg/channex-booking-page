// Transactional email delivery via SparkPost (https://sparkpost.com).
//
// `sendEmail` is the single low-level send used by everything: the admin
// magic-link (auth.server) and the guest/host booking emails. When the
// SparkPost API key or EMAIL_FROM is missing (local dev), it logs a one-line
// summary and reports `{ sent: false }` so flows still work without real mail.
// It never throws — a mail failure must never break a booking or sign-in.
//
// PROD: SparkPost has no shared sandbox sender, so EMAIL_FROM must be on a
// SparkPost-verified sending domain. EU accounts must set SPARKPOST_API_URL to
// https://api.eu.sparkpost.com.
import type { BookingRecord } from "./bookings.server";
import { emailDef, type SiteSettings } from "./content";
import { getConfig, type AppConfig } from "./config.server";
import { accentHex, composeEmail } from "./email-render.server";
import { getEmailTemplate, getOverrides, getSettings } from "./overrides.server";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  /** Overrides the global EMAIL_FROM sender. */
  from?: string;
  replyTo?: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<{ sent: boolean; error?: string }> {
  const { sparkpostApiKey, sparkpostApiUrl, emailFrom } = getConfig();
  const to = Array.isArray(opts.to) ? opts.to : [opts.to];
  const from = opts.from || emailFrom;

  // SparkPost needs both a key and a verified-domain sender; without either we
  // can't send, so log and no-op (lets dev + sign-in flows work mail-free).
  if (!sparkpostApiKey || !from) {
    const why = !sparkpostApiKey ? "no SPARKPOST_API_KEY" : "no EMAIL_FROM";
    console.log(`[email] (${why}) would send "${opts.subject}" to ${to.join(", ")}`);
    return { sent: false };
  }

  try {
    const res = await fetch(`${sparkpostApiUrl}/api/v1/transmissions`, {
      method: "POST",
      headers: {
        Authorization: sparkpostApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        options: { transactional: true },
        content: {
          from,
          subject: opts.subject,
          html: opts.html,
          ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
        },
        recipients: to.map((address) => ({ address })),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const error = `SparkPost responded ${res.status}`;
      console.log(`[email] send failed: ${error} (to ${to.join(", ")})${detail ? ` — ${detail.slice(0, 500)}` : ""}`);
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
// The sending domain is global (EMAIL_FROM); the property only overrides the
// display name.
function senderFrom(settings: SiteSettings, config: AppConfig): string | undefined {
  const base = config.emailFrom;
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
