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
//
// NO RECIPIENT TRACKING, and that is a property of this file. `sendEmail` sets
// `open_tracking: false` and `click_tracking: false` on every transmission.
// Because they are sent explicitly per-transmission they override whatever the
// SparkPost account defaults are, so nobody can switch tracking on for us from
// the dashboard. Our own HTML contains no <img>, no remote CSS and no script, so
// there is nowhere for a pixel to hide, and links are written plain — never
// wrapped through a redirector and never tagged with campaign parameters.
//
// Keep it that way: EVERY email must go out through `sendEmail`. A second
// fetch to a mail API somewhere else in the codebase would quietly opt us back
// into a vendor's defaults.
import type { BookingRecord } from "./bookings.server";
import { emailDef, type SiteSettings } from "./content";
import { getConfig, type AppConfig } from "./config.server";
import { accentHex, composeEmail, composeReviewEmail, emailBrand, renderSimpleEmail } from "./email-render.server";
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
    const brand = await emailBrand(pid, accentHex(settings));
    const from = senderFrom(settings, getConfig());
    const manageUrl = `${origin}/${pid}/manage/${booking.id}`;
    const gtext = await getEmailTemplate(pid, "booking_confirmation", booking.lang);
    const g = composeEmail({ def: emailDef("booking_confirmation")!, text: gtext, booking, hotelName, brand, manageUrl });
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
    const brand = await emailBrand(pid, accentHex(settings));
    const from = senderFrom(settings, getConfig());
    const manageUrl = `${origin}/${pid}/manage/${booking.id}`;

    await sendGuestBookingEmail(pid, booking, origin);

    const hostTo = settings.hostNotifyEmail || ov.email;
    if (settings.notifyHostOnBooking !== false && hostTo) {
      const htext = await getEmailTemplate(pid, "host_notification", booking.lang);
      const h = composeEmail({ def: emailDef("host_notification")!, text: htext, booking, hotelName, brand, manageUrl });
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
    const g = composeEmail({ def: emailDef("booking_failed")!, text, booking, hotelName, brand: await emailBrand(pid, accentHex(settings)), manageUrl: "" });
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
/** Review-request email (attempt 1–3): five tappable stars deep-linking into
 *  the review page with the rating prefilled. Returns whether the send was
 *  accepted so the cron only counts real attempts. Never throws. */
export async function sendReviewRequestEmail(
  pid: string,
  booking: BookingRecord,
  reviewUrl: string,
): Promise<boolean> {
  try {
    const [settings, ov, text] = await Promise.all([
      getSettings(pid),
      getOverrides(pid, booking.lang),
      getEmailTemplate(pid, "review_request", booking.lang),
    ]);
    const hotelName = ov.hotelName || "Your hotel";
    const { subject, html } = composeReviewEmail({
      text,
      booking,
      hotelName,
      brand: await emailBrand(pid, accentHex(settings)),
      reviewUrl,
    });
    const r = await sendEmail({
      to: booking.guest.email,
      subject,
      html,
      from: senderFrom(settings, getConfig()),
      replyTo: settings.emailReplyTo,
    });
    return r.sent;
  } catch (e) {
    console.log(`[email] sendReviewRequestEmail failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

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
      brand: await emailBrand(pid, accentHex(settings)),
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

/** Tells a property it has been listed in someone else's collection.
 *
 *  This is what makes an immediate add fair. A `curated` collection can list a
 *  property without asking first, so the property has to actually LEARN about
 *  it — an in-admin badge they might never look at isn't good enough.
 *
 *  Deliberately does not name the operator: the collection's own name and its
 *  public page are enough to decide, and passing one customer's email address
 *  to another isn't ours to do. */
export async function sendCollectionMembershipEmail(args: {
  pid: string;
  to: string;
  kind: "added" | "invited" | "approved" | "declined";
  propertyName: string;
  collectionName: string;
  collectionUrl: string;
  manageUrl: string;
}): Promise<{ sent: boolean }> {
  try {
    const [settings, ov] = await Promise.all([getSettings(args.pid), getOverrides(args.pid)]);
    const hotelName = ov.hotelName || args.propertyName;
    const copy = {
      added: {
        subject: `${args.propertyName} is now listed in ${args.collectionName}`,
        heading: `${args.propertyName} has been added to a collection`,
        body:
          `${args.propertyName} is now shown on the ${args.collectionName} collection page (${args.collectionUrl}).\n\n` +
          `You didn't need to do anything, and you don't have to stay. You can remove your property at any time, ` +
          `or refuse the collection so it can't add you again.`,
        label: "Manage your listings",
      },
      invited: {
        subject: `${args.collectionName} has invited ${args.propertyName}`,
        heading: `An invitation to join ${args.collectionName}`,
        body:
          `${args.collectionName} would like to list ${args.propertyName} on its collection page (${args.collectionUrl}).\n\n` +
          `Nothing is shown until you accept. If you'd rather not, decline and nothing happens.`,
        label: "Review the invitation",
      },
      approved: {
        subject: `${args.propertyName} has joined ${args.collectionName}`,
        heading: `Your request was approved`,
        body:
          `${args.propertyName} is now listed on the ${args.collectionName} collection page (${args.collectionUrl}).\n\n` +
          `You can remove your property at any time.`,
        label: "Manage your listings",
      },
      declined: {
        subject: `${args.collectionName} declined your request`,
        heading: `Your request wasn't accepted`,
        body:
          `${args.collectionName} has declined the request to list ${args.propertyName}.\n\n` +
          `Collections choose their own members, so this isn't a reflection on your property.`,
        label: "Browse collections",
      },
    }[args.kind];

    return await sendEmail({
      to: args.to,
      subject: copy.subject,
      from: senderFrom(settings, getConfig()),
      replyTo: settings.emailReplyTo,
      html: renderSimpleEmail({
        hotelName,
        brand: await emailBrand(args.pid, accentHex(settings)),
        heading: copy.heading,
        body: copy.body,
        cta: { label: copy.label, url: args.manageUrl },
      }),
    });
  } catch (e) {
    console.log(`[email] sendCollectionMembershipEmail failed: ${e instanceof Error ? e.message : e}`);
    return { sent: false };
  }
}

/** Tells a collection's operators that a property has asked to join.
 *
 *  Operator-facing, so unlike sendCollectionMembershipEmail it does NOT adopt
 *  the property's sender name — an email that arrived "from Spilman Hotel" about
 *  Spilman Hotel's own request reads like a spoof. The property's accent is used
 *  for the tint only, and the sender stays the platform default. */
export async function sendCollectionRequestEmail(args: {
  /** The REQUESTING property — used for the visual tint, not for identity. */
  pid: string;
  to: string[];
  propertyName: string;
  propertyLocation?: string;
  collectionName: string;
  reviewUrl: string;
}): Promise<{ sent: boolean }> {
  if (args.to.length === 0) return { sent: false };
  try {
    const settings = await getSettings(args.pid);
    const where = args.propertyLocation ? ` (${args.propertyLocation})` : "";
    return await sendEmail({
      to: args.to,
      subject: `${args.propertyName} would like to join ${args.collectionName}`,
      html: renderSimpleEmail({
        hotelName: args.collectionName,
        brand: await emailBrand(args.pid, accentHex(settings)),
        heading: `A property has asked to join ${args.collectionName}`,
        body:
          `${args.propertyName}${where} has asked to be listed in ${args.collectionName}.\n\n` +
          `Nothing appears on your collection page until you approve it. You can see how much of the coming ` +
          `year they have rooms for sale before deciding.`,
        cta: { label: "Review the request", url: args.reviewUrl },
      }),
    });
  } catch (e) {
    console.log(`[email] sendCollectionRequestEmail failed: ${e instanceof Error ? e.message : e}`);
    return { sent: false };
  }
}

/** Contact-form enquiry, host-facing. The guest's name, address and message are
 *  untrusted: they go through `renderSimpleEmail`, whose body is escaped, and
 *  NEVER into the subject — a newline in a mail header is header injection.
 *  `replyTo` is the guest, so the hotel can just hit reply. */
export async function sendContactEmail(args: {
  pid: string;
  to: string;
  hotelName: string;
  guestName: string;
  guestEmail: string;
  message: string;
}): Promise<{ sent: boolean }> {
  try {
    const settings = await getSettings(args.pid);
    return await sendEmail({
      to: args.to,
      // Fixed text plus the hotel's own name — nothing the sender controls.
      subject: `Website enquiry — ${args.hotelName}`,
      replyTo: args.guestEmail,
      html: renderSimpleEmail({
        hotelName: args.hotelName,
        brand: await emailBrand(args.pid, accentHex(settings)),
        heading: "New enquiry from your website",
        body:
          `${args.guestName} <${args.guestEmail}> wrote:\n\n${args.message}\n\n` +
          `Reply to this email to answer them directly.`,
      }),
    });
  } catch (e) {
    console.log(`[email] sendContactEmail failed: ${e instanceof Error ? e.message : e}`);
    return { sent: false };
  }
}

/** Guest cancellation confirmation + (opt-in) host cancellation notification. */
export async function sendCancellationEmails(pid: string, booking: BookingRecord, origin: string): Promise<void> {
  try {
    const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid, booking.lang)]);
    const hotelName = ov.hotelName || "Your hotel";
    const brand = await emailBrand(pid, accentHex(settings));
    const from = senderFrom(settings, getConfig());
    const manageUrl = `${origin}/${pid}/manage/${booking.id}`;

    const gtext = await getEmailTemplate(pid, "booking_cancellation", booking.lang);
    const g = composeEmail({ def: emailDef("booking_cancellation")!, text: gtext, booking, hotelName, brand, manageUrl });
    await sendEmail({ to: booking.guest.email, subject: g.subject, html: g.html, from, replyTo: settings.emailReplyTo });

    const hostTo = settings.hostNotifyEmail || ov.email;
    if (settings.notifyHostOnCancel !== false && hostTo) {
      const htext = await getEmailTemplate(pid, "cancellation_notification", booking.lang);
      const h = composeEmail({ def: emailDef("cancellation_notification")!, text: htext, booking, hotelName, brand, manageUrl });
      await sendEmail({ to: hostTo, subject: h.subject, html: h.html, from, replyTo: booking.guest.email });
    }
  } catch (e) {
    console.log(`[email] sendCancellationEmails failed: ${e instanceof Error ? e.message : e}`);
  }
}
