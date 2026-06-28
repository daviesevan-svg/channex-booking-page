// Renders transactional emails: token substitution + a branded, email-safe
// HTML shell with an auto-generated booking details block. Operators only edit
// plain prose (subject/heading/intro/outro); everything structural lives here.
import { format, parseISO } from "date-fns";

import type { BookingRecord } from "./bookings.server";
import type { EmailDef, SiteSettings } from "./content";
import { THEMES, type ThemeId } from "./content";
import { formatMoney } from "./money";

// Email clients need plain hex, not the oklch theme tokens. Hand-picked to
// match each [data-theme] accent closely enough for a header band.
const ACCENT_HEX: Record<ThemeId, string> = {
  terracotta: "#bf5a3c",
  sage: "#5f7d63",
  indigo: "#5a5fb0",
  ocean: "#3f7aa8",
  plum: "#9a4d7a",
};

export function accentHex(settings: SiteSettings): string {
  if (settings.theme === "custom" && settings.customColor) return settings.customColor;
  const id = (settings.theme && settings.theme !== "custom" ? settings.theme : "terracotta") as ThemeId;
  return ACCENT_HEX[id] ?? ACCENT_HEX.terracotta;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Replace {token}s with values; unknown tokens are left literal (never throws),
 *  so an AI edit can't break rendering. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Escaped, line-break-aware paragraphs from operator prose. Empty -> "". */
function paragraphs(text: string): string {
  const t = text.trim();
  if (!t) return "";
  return t
    .split(/\n{2,}/)
    .map(
      (block) =>
        `<p style="margin:0 0 14px;color:#3a3a3a;font-size:15px;line-height:1.6;">${esc(block).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

const fmtDate = (iso: string) => {
  try {
    return format(parseISO(iso), "EEE d MMM yyyy");
  } catch {
    return iso;
  }
};
const fmtDateTime = (iso: string) => {
  try {
    return format(parseISO(iso), "d MMM yyyy, HH:mm");
  } catch {
    return iso;
  }
};

/** Plain (unescaped) token values for subject + prose substitution. */
export function bookingVars(
  booking: BookingRecord,
  hotelName: string,
  manageUrl: string,
): Record<string, string> {
  const money = (n: number) => formatMoney(n, booking.currency);
  const dueNow = booking.consent?.dueNow ?? 0;
  return {
    hotel_name: hotelName,
    guest_first_name: booking.guest.firstName,
    guest_last_name: booking.guest.lastName,
    reference: booking.reference,
    checkin: fmtDate(booking.checkin),
    checkout: fmtDate(booking.checkout),
    nights: String(booking.nights),
    total: money(booking.total),
    due_now: money(dueNow),
    due_at_hotel: money(Math.max(0, booking.total - dueNow)),
    manage_url: manageUrl,
    guest_email: booking.guest.email,
    guest_phone: booking.guest.phone,
  };
}

const LABEL = "color:#8a8a8a;font-size:13px;";
const VALUE = "color:#1f1f1f;font-size:14px;font-weight:600;text-align:right;";
const ROW = (label: string, value: string, strong = false) =>
  `<tr><td style="padding:6px 0;${LABEL}">${esc(label)}</td><td style="padding:6px 0;${VALUE}${strong ? "font-size:16px;" : ""}">${esc(value)}</td></tr>`;

function detailsHtml(
  booking: BookingRecord,
  opts: { recipient: "guest" | "host"; manageUrl: string; accent: string },
): string {
  const money = (n: number) => formatMoney(n, booking.currency);
  const dueNow = booking.consent?.dueNow ?? 0;
  const dueAtHotel = Math.max(0, booking.total - dueNow);

  const occ = (a: number, c: number) =>
    `${a} adult${a === 1 ? "" : "s"}${c ? `, ${c} child${c === 1 ? "" : "ren"}` : ""}`;

  const roomRows = booking.rooms
    .map(
      (r) =>
        `<tr><td style="padding:8px 0;border-top:1px solid #eee;">
           <div style="color:#1f1f1f;font-size:14px;font-weight:600;">${esc(r.roomTitle)}</div>
           <div style="color:#8a8a8a;font-size:12px;">${esc(r.rateTitle)} · ${esc(occ(r.adults, r.children))}</div>
         </td><td style="padding:8px 0;border-top:1px solid #eee;${VALUE}">${esc(money(r.total))}</td></tr>`,
    )
    .join("");

  const extraRows = (booking.extras ?? [])
    .map(
      (x) =>
        `<tr><td style="padding:4px 0;${LABEL}">${esc(x.name)}${x.optionName ? ` — ${esc(x.optionName)}` : ""}${x.qty > 1 ? ` ×${x.qty}` : ""}</td><td style="padding:4px 0;${VALUE}">${esc(money(x.amount))}</td></tr>`,
    )
    .join("");

  const cancel = booking.cancellation;
  const cancelLine = !cancel
    ? ""
    : cancel.refundable
      ? cancel.cancelByISO
        ? `Free cancellation until ${fmtDateTime(cancel.cancelByISO)}`
        : "Free cancellation"
      : "Non-refundable";

  const manageBtn =
    opts.recipient === "guest"
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;"><tr><td style="border-radius:10px;background:${opts.accent};">
           <a href="${esc(opts.manageUrl)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">Manage booking</a>
         </td></tr></table>`
      : "";

  const contactBlock =
    opts.recipient === "host"
      ? `<table role="presentation" width="100%" style="margin-top:14px;border-top:1px solid #eee;">
           ${ROW("Guest", `${booking.guest.firstName} ${booking.guest.lastName}`)}
           ${ROW("Email", booking.guest.email)}
           ${booking.guest.phone ? ROW("Phone", booking.guest.phone) : ""}
           ${booking.guest.requests ? ROW("Requests", booking.guest.requests) : ""}
         </table>`
      : "";

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;border:1px solid #ececec;border-radius:12px;padding:18px;background:#fbfafa;">
    <tr><td>
      <table role="presentation" width="100%">
        ${ROW("Reference", booking.reference)}
        ${ROW("Check-in", fmtDate(booking.checkin))}
        ${ROW("Check-out", fmtDate(booking.checkout))}
        ${ROW("Nights", String(booking.nights))}
      </table>
      <table role="presentation" width="100%">${roomRows}</table>
      ${extraRows ? `<table role="presentation" width="100%" style="margin-top:6px;">${extraRows}</table>` : ""}
      <table role="presentation" width="100%" style="margin-top:6px;border-top:2px solid #e2e2e2;">
        ${ROW("Total", money(booking.total), true)}
        ${dueNow > 0 ? ROW("Due now", money(dueNow)) : ""}
        ${ROW("Due at the hotel", money(dueAtHotel))}
      </table>
      ${cancelLine ? `<p style="margin:12px 0 0;color:#8a8a8a;font-size:12px;">${esc(cancelLine)}</p>` : ""}
      ${contactBlock}
      ${manageBtn}
    </td></tr>
  </table>`;
}

function shell(args: {
  hotelName: string;
  accent: string;
  heading: string;
  introHtml: string;
  details: string;
  outroHtml: string;
}): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f1ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ee;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="background:${args.accent};padding:20px 28px;">
          <span style="color:#ffffff;font-size:18px;font-weight:700;">${esc(args.hotelName)}</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 16px;color:#1f1f1f;font-size:22px;font-weight:700;">${args.heading}</h1>
          ${args.introHtml}
          ${args.details}
          ${args.outroHtml}
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #eee;color:#a0a0a0;font-size:12px;">
          ${esc(args.hotelName)}
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

/** Compose a full email (subject + HTML) for a template + booking. */
export function composeEmail(args: {
  def: EmailDef;
  text: Record<string, string>;
  booking: BookingRecord;
  hotelName: string;
  accent: string;
  manageUrl: string;
}): { subject: string; html: string } {
  const vars = bookingVars(args.booking, args.hotelName, args.manageUrl);
  const subject = renderTemplate(args.text.subject ?? "", vars);
  const heading = esc(renderTemplate(args.text.heading ?? "", vars));
  const introHtml = paragraphs(renderTemplate(args.text.intro ?? "", vars));
  const outroHtml = paragraphs(renderTemplate(args.text.outro ?? "", vars));
  const details = detailsHtml(args.booking, {
    recipient: args.def.recipient,
    manageUrl: args.manageUrl,
    accent: args.accent,
  });
  return {
    subject,
    html: shell({ hotelName: args.hotelName, accent: args.accent, heading, introHtml, details, outroHtml }),
  };
}

/** A representative booking for editor previews + test sends. */
export function sampleBooking(currency = "GBP"): BookingRecord {
  return {
    id: "sample",
    reference: "AB7C9XK2",
    status: "confirmed",
    lifecycle: "active",
    createdAt: "2025-01-01T10:00:00.000Z",
    currency,
    checkin: "2025-08-14",
    checkout: "2025-08-17",
    nights: 3,
    total: 540,
    cancellation: { refundable: true, cancelByISO: "2025-08-12T15:00:00.000Z" },
    guest: {
      firstName: "Jamie",
      lastName: "Rivera",
      email: "jamie@example.com",
      phone: "+44 7700 900123",
      requests: "Late arrival, around 9pm.",
    },
    rooms: [
      { roomId: "r1", roomTitle: "Garden Suite", rateId: "rt1", rateTitle: "Bed & Breakfast", adults: 2, children: 1, total: 480 },
    ],
    extras: [{ id: "x1", name: "Airport transfer", unit: "trip", unitPrice: 60, qty: 1, amount: 60 }],
    consent: { acceptedAt: "2025-01-01T10:00:00.000Z", policyText: [], dueNow: 180, marketingOptIn: false },
  };
}
