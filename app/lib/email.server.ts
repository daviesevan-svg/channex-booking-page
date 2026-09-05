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
import { DEFAULT_LANG, emailDef, type SiteSettings } from "./content";
import { getConfig } from "./config.server";
import { accentHex, composeEmail, composeReviewEmail, DEFAULT_ACCENT_HEX, emailBrand, legalLinksForEmail, renderSimpleEmail } from "./email-render.server";
import { emailBrandFor } from "./site-style";
import { getEmailTemplate, getOverrides, getSettings } from "./overrides.server";
import { brandOf, getPartner, partnerForProperty } from "./partners.server";

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
// The sending ADDRESS follows the property's partner when it has its own
// verified sender (docs/whitelabel.md §6 phase 2), else the global EMAIL_FROM;
// the property's emailFromName still only overrides the display name. Exported
// for the other property-scoped senders (voucher-purchase.server).
export async function senderFor(pid: string, settings: SiteSettings): Promise<string | undefined> {
  const base = brandOf(await partnerForProperty(pid)).emailFrom || getConfig().emailFrom;
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
    const from = await senderFor(pid, settings);
    const manageUrl = `${origin}/${pid}/manage/${booking.id}`;
    const gtext = await getEmailTemplate(pid, "booking_confirmation", booking.lang);
    // The contract terms, in a form the guest keeps — § 312i(1) BGB. See
    // legalLinksForEmail; host emails drop them inside composeEmail.
    const legal = legalLinksForEmail(settings, booking.lang ?? DEFAULT_LANG);
    const g = composeEmail({ def: emailDef("booking_confirmation")!, text: gtext, booking, hotelName, brand, manageUrl, legal });
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
    const from = await senderFor(pid, settings);
    const manageUrl = `${origin}/${pid}/manage/${booking.id}`;

    await sendGuestBookingEmail(pid, booking, origin);

    const hostTo = settings.hostNotifyEmail || ov.email;
    if (settings.notifyHostOnBooking !== false && hostTo) {
      // Host emails stay in the default language: the recipient is the
      // hotelier, and the guest's language says nothing about theirs.
      const htext = await getEmailTemplate(pid, "host_notification");
      const h = composeEmail({ def: emailDef("host_notification")!, text: htext, booking, hotelName, brand, manageUrl, lang: DEFAULT_LANG });
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
    const from = await senderFor(pid, settings);
    const text = await getEmailTemplate(pid, "booking_failed", booking.lang);
    const g = composeEmail({ def: emailDef("booking_failed")!, text, booking, hotelName, brand: await emailBrand(pid, accentHex(settings)), manageUrl: "", legal: legalLinksForEmail(settings, booking.lang ?? DEFAULT_LANG) });
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
/**
 * The guest portal sign-in link, sent when a booking reference alone is not
 * enough — i.e. when this email has more than one record at the property and
 * the portal would otherwise reveal records the caller never proved.
 *
 * Branded and sent from the property, unlike the admin link: the guest asked
 * a hotel for it, and a sign-in mail from an unfamiliar sender reads as
 * phishing. English copy deliberately — the link is the payload, and a new
 * operator-editable template is a bigger surface than this fix warrants.
 */
export async function sendGuestPortalLink(
  pid: string,
  email: string,
  link: string,
): Promise<boolean> {
  const [settings, overrides] = await Promise.all([getSettings(pid), getOverrides(pid, DEFAULT_LANG)]);
  // The hotel name is operator-written and lands inside markup; escape it.
  // The link is ours (base64url token) but costs nothing to treat the same way.
  const e = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const hotel = e(overrides.hotelName || "the hotel");
  const href = e(link);
  const { sent } = await sendEmail({
    to: email,
    subject: `Your booking link for ${overrides.hotelName || "your stay"}`,
    html:
      `<p>Here is your sign-in link for your bookings at ${hotel}:</p>` +
      `<p><a href="${href}">${href}</a></p>` +
      `<p>This link expires in 15 minutes. If you did not ask for it you can ignore this email — ` +
      `nothing has changed on your booking.</p>`,
    from: await senderFor(pid, settings),
    replyTo: overrides.email || undefined,
  });
  if (!sent) console.log(`[guest] portal link email failed for ${pid}`);
  return sent;
}

export async function sendReviewRequestEmail(
  pid: string,
  booking: BookingRecord,
  reviewUrl: string,
  /** Which of the three asks this is — picks the subject line. */
  attempt = 1,
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
      attempt,
    });
    const r = await sendEmail({
      to: booking.guest.email,
      subject,
      html,
      from: await senderFor(pid, settings),
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
  /** The property's white-label partner, resolved by the caller (email.server
   *  can't import properties.server — that cycles back through auth.server). */
  partnerId?: string,
): Promise<{ sent: boolean }> {
  try {
    const [settings, ov, product] = await Promise.all([
      getSettings(pid),
      getOverrides(pid),
      getPartner(partnerId).then(brandOf),
    ]);
    const hotelName = ov.hotelName || "the property";
    // A partner's invites are UNIFORM: every hotel they onboard sends the same-
    // looking mail (partner accent, default email template), because the
    // recipient judges the PMS by this email, not the hotel — per-property
    // theming here read as inconsistent branding to partners. Direct
    // properties keep their own theme; guest emails stay hotel-themed always.
    const brand = product.partnerId
      ? emailBrandFor(product.accent ?? DEFAULT_ACCENT_HEX, undefined)
      : await emailBrand(pid, accentHex(settings));
    const html = renderSimpleEmail({
      hotelName,
      brand,
      heading: `You've been added to ${hotelName}`,
      body:
        `${invitedBy} has given you access to manage ${hotelName} on ${product.name}.\n\n` +
        `To get started, sign in with your email address (${toEmail}) — no password needed. ` +
        `We'll email you a one-time link each time you sign in.`,
      cta: { label: "Sign in", url: signInUrl },
    });
    return await sendEmail({
      to: toEmail,
      subject: `You've been added to ${hotelName} on ${product.name}`,
      from: await senderFor(pid, settings),
      replyTo: product.supportEmail || settings.emailReplyTo,
      html,
    });
  } catch (e) {
    console.log(`[email] sendTeamInviteEmail failed: ${e instanceof Error ? e.message : e}`);
    return { sent: false };
  }
}

/** Tells the OWNER that an integration (a management API key) asked to add
 *  someone to the team. Nothing has happened yet — the owner approves or
 *  declines on the Team page. The requested address is shown but not mailed. */
export async function sendTeamInviteRequestEmail(
  pid: string,
  ownerEmail: string,
  requestedEmail: string,
  teamUrl: string,
  partnerId?: string,
): Promise<{ sent: boolean }> {
  try {
    const [settings, ov, product] = await Promise.all([
      getSettings(pid),
      getOverrides(pid),
      getPartner(partnerId).then(brandOf),
    ]);
    const hotelName = ov.hotelName || "your property";
    const brand = product.partnerId
      ? emailBrandFor(product.accent ?? DEFAULT_ACCENT_HEX, undefined)
      : await emailBrand(pid, accentHex(settings));
    const html = renderSimpleEmail({
      hotelName,
      brand,
      heading: `Approve a new teammate for ${hotelName}?`,
      body:
        `An integration connected to ${hotelName} through its management API key asked to add ${requestedEmail} to the team.\n\n` +
        `Nobody has been added and no sign-in link has been sent. If you recognise this request, approve it on the Team page; ` +
        `otherwise decline it — and if you don't recognise the integration either, revoke its API key.`,
      cta: { label: "Review on the Team page", url: teamUrl },
    });
    return await sendEmail({
      to: ownerEmail,
      subject: `Approve a new teammate for ${hotelName}?`,
      from: await senderFor(pid, settings),
      replyTo: product.supportEmail || settings.emailReplyTo,
      html,
    });
  } catch (e) {
    console.log(`[email] sendTeamInviteRequestEmail failed: ${e instanceof Error ? e.message : e}`);
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
      from: await senderFor(args.pid, settings),
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
      from: await senderFor(args.pid, settings),
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
    const from = await senderFor(pid, settings);
    const manageUrl = `${origin}/${pid}/manage/${booking.id}`;

    const gtext = await getEmailTemplate(pid, "booking_cancellation", booking.lang);
    const legal = legalLinksForEmail(settings, booking.lang ?? DEFAULT_LANG);
    const g = composeEmail({ def: emailDef("booking_cancellation")!, text: gtext, booking, hotelName, brand, manageUrl, legal });
    await sendEmail({ to: booking.guest.email, subject: g.subject, html: g.html, from, replyTo: settings.emailReplyTo });

    const hostTo = settings.hostNotifyEmail || ov.email;
    if (settings.notifyHostOnCancel !== false && hostTo) {
      // Default language for the hotelier, as with the new-booking email.
      const htext = await getEmailTemplate(pid, "cancellation_notification");
      const h = composeEmail({ def: emailDef("cancellation_notification")!, text: htext, booking, hotelName, brand, manageUrl, lang: DEFAULT_LANG });
      await sendEmail({ to: hostTo, subject: h.subject, html: h.html, from, replyTo: booking.guest.email });
    }
  } catch (e) {
    console.log(`[email] sendCancellationEmails failed: ${e instanceof Error ? e.message : e}`);
  }
}
