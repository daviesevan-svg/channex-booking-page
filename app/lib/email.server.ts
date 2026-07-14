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
import { accentHex, composeEmail, renderSimpleEmail } from "./email-render.server";
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
    const why = !sparkpostApiKey ? "no SPARKPOST_API_KEY set" : "no EMAIL_FROM set";
    console.log(`[email] (${why}) would send "${opts.subject}" to ${to.join(", ")}`);
    return { sent: false, error: why };
  }

  try {
    const res = await fetch(`${sparkpostApiUrl}/api/v1/transmissions`, {
      method: "POST",
      headers: {
        Authorization: sparkpostApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Transactional, and no open/click tracking — we don't track recipients.
        options: { transactional: true, open_tracking: false, click_tracking: false },
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
      let reason = "";
      try {
        reason = (JSON.parse(detail) as { errors?: { message?: string }[] })?.errors?.[0]?.message ?? "";
      } catch {
        /* non-JSON body */
      }
      const error = `SparkPost responded ${res.status}${reason ? ` — ${reason}` : ""}`;
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

/** Send (or re-send) just the guest booking confirmation. Returns whether the
 *  send was accepted, so the admin "Resend email" button can show the outcome.
 *  Never throws. */
export async function sendGuestBookingEmail(pid: string, booking: BookingRecord, origin: string): Promise<boolean> {
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid, booking.lang)]);
    const hotelName = ov.hotelName || "Your hotel";
    const accent = accentHex(settings);
    const from = senderFrom(settings, getConfig());
    const manageUrl = `${origin}/${pid}/manage/${booking.id}`;
    const gtext = await getEmailTemplate(pid, "booking_confirmation", booking.lang);
    const g = composeEmail({ def: emailDef("booking_confirmation")!, text: gtext, booking, hotelName, accent, manageUrl });
    const r = await sendEmail({ to: booking.guest.email, subject: g.subject, html: g.html, from, replyTo: settings.emailReplyTo });
    return r.sent;
  } catch (e) {
    console.log(`[email] sendGuestBookingEmail failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
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

    await sendGuestBookingEmail(pid, booking, origin);

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

/** Guest "couldn't confirm — you've been refunded" email, sent when a paid
 *  booking can't be fulfilled (room sold out before payment completed). No manage
 *  link (there's no booking to manage). Never throws. */
export async function sendBookingFailedEmail(pid: string, booking: BookingRecord, _origin: string): Promise<void> {
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid, booking.lang)]);
    const hotelName = ov.hotelName || "Your hotel";
    const from = senderFrom(settings, getConfig());
    const text = await getEmailTemplate(pid, "booking_failed", booking.lang);
    const g = composeEmail({ def: emailDef("booking_failed")!, text, booking, hotelName, accent: accentHex(settings), manageUrl: "" });
    await sendEmail({ to: booking.guest.email, subject: g.subject, html: g.html, from, replyTo: settings.emailReplyTo });
  } catch (e) {
    console.log(`[email] sendBookingFailedEmail failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Tells a newly-added teammate they now have access to a property and points
 *  them at the sign-in page (they get a fresh magic link there — we don't bake a
 *  15-minute token into an email that may be read hours later). Branded with the
 *  property's name + accent. Never throws — a mail failure must not break the
 *  invite (the member is already added). */
export async function sendTeamInviteEmail(
  pid: string,
  toEmail: string,
  invitedBy: string,
  signInUrl: string,
): Promise<{ sent: boolean }> {
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid)]);
    const hotelName = ov.hotelName || "the property";
    const html = renderSimpleEmail({
      hotelName,
      accent: accentHex(settings),
      heading: `You've been added to ${hotelName}`,
      body:
        `${invitedBy} has given you access to manage ${hotelName} on Roompanda.\n\n` +
        `To get started, sign in with your email address (${toEmail}) — no password needed. ` +
        `We'll email you a one-time link each time you sign in.`,
      cta: { label: "Sign in", url: signInUrl },
    });
    return await sendEmail({
      to: toEmail,
      subject: `You've been added to ${hotelName} on Roompanda`,
      from: senderFrom(settings, getConfig()),
      replyTo: settings.emailReplyTo,
      html,
    });
  } catch (e) {
    console.log(`[email] sendTeamInviteEmail failed: ${e instanceof Error ? e.message : e}`);
    return { sent: false };
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
