// Booking confirmation as a downloadable PDF — for hotels to print or forward
// manually when the guest didn't receive the confirmation email. Generated
// with pdf-lib (pure JS, no headless browser in a Worker) and mirrors the
// email's details block: stay dates, rooms, extras, taxes & fees, totals,
// cancellation line. Text uses embedded Noto Sans subsets (Latin + Greek +
// Cyrillic, plus Noto Sans Thai for Thai), so guest names like "Νίκος",
// "Дмитрий" or "สมชาย" render properly — pdf-lib's standard fonts are
// WinAnsi-only. Font selection per string lives in fonts/pdf-fonts.ts.
import { PDFDocument, PDFFont, PDFPage, rgb, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { format, parseISO } from "date-fns";

import { formatCancelDeadline } from "./cancellation";

import type { BookingRecord } from "./bookings.server";
import { formatMoney } from "./money";
import { embedPdfFonts, wrapText } from "./fonts/pdf-fonts";

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.12, 0.12, 0.12);
const MUTED = rgb(0.54, 0.54, 0.54);
const LINE = rgb(0.9, 0.88, 0.85);

function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return rgb(0.75, 0.35, 0.24); // terracotta fallback
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
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

export interface BookingPdfInput {
  booking: BookingRecord;
  hotelName: string;
  /** Hex accent for the header band (from the property theme). */
  accent: string;
  address?: string;
  phone?: string;
}

export async function renderBookingPdf(input: BookingPdfInput): Promise<Uint8Array> {
  const { booking: b, hotelName } = input;
  const accent = hexToRgb(input.accent);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // The whole payload is the sample: it's what decides whether the Thai family
  // is embedded at all, and every string drawn below comes out of it — except
  // the formatted amounts, hence the sample amount. THB's ฿ sits in the Thai
  // block and Intl emits it for some locales, so a THB PDF needs the Thai
  // family even when every word on it is English.
  const { regular: font, bold, fontFor } = await embedPdfFonts(
    doc,
    JSON.stringify(input) + formatMoney(0, b.currency),
  );
  doc.setTitle(`Booking confirmation ${b.reference}`);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H;

  // Cursor helpers — a new page continues below a slim accent band.
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: PAGE_H - 14, width: PAGE_W, height: 14, color: accent });
    y = PAGE_H - 44;
  };
  const ensure = (needed: number) => {
    if (y - needed < MARGIN + 30) newPage();
  };
  const text = (
    s: string,
    opts: { x?: number; size?: number; font?: PDFFont; color?: RGB; rightAt?: number } = {},
  ) => {
    const f = fontFor(s, opts.font ?? font);
    const size = opts.size ?? 10.5;
    const x = opts.rightAt != null ? opts.rightAt - f.widthOfTextAtSize(s, size) : (opts.x ?? MARGIN);
    page.drawText(s, { x, y, size, font: f, color: opts.color ?? INK });
  };
  const rule = (top = 10, bottom = 12) => {
    y -= top;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.7, color: LINE });
    y -= bottom;
  };
  const labelValue = (label: string, value: string) => {
    ensure(16);
    text(label, { size: 9.5, color: MUTED });
    text(value, { rightAt: PAGE_W - MARGIN, font: bold, size: 10.5 });
    y -= 16;
  };

  // ---- header band ----
  page.drawRectangle({ x: 0, y: PAGE_H - 74, width: PAGE_W, height: 74, color: accent });
  y = PAGE_H - 47;
  text(hotelName, { size: 17, font: bold, color: rgb(1, 1, 1) });
  y = PAGE_H - 108;
  text("Booking confirmation", { size: 21, font: bold });
  y -= 17;
  text(`Reference ${b.reference} · booked ${fmtDateTime(b.createdAt)}`, { size: 10, color: MUTED });
  if ((b.lifecycle ?? "active") !== "active") {
    y -= 14;
    text("CANCELLED", { size: 10.5, font: bold, color: rgb(0.75, 0.22, 0.17) });
  }
  y -= 24;

  // ---- guest + stay ----
  labelValue("Guest", `${b.guest.firstName} ${b.guest.lastName}`);
  labelValue("Email", b.guest.email);
  if (b.guest.phone) labelValue("Phone", b.guest.phone);
  rule();
  labelValue("Check-in", fmtDate(b.checkin));
  labelValue("Check-out", fmtDate(b.checkout));
  labelValue("Nights", String(b.nights));
  rule();

  const money = (n: number) => formatMoney(n, b.currency);
  const occ = (a: number, c: number) =>
    `${a} adult${a === 1 ? "" : "s"}${c ? `, ${c} child${c === 1 ? "" : "ren"}` : ""}`;

  // ---- rooms ----
  for (const r of b.rooms) {
    ensure(30);
    text(r.roomTitle, { font: bold, size: 10.5 });
    text(money(r.total), { rightAt: PAGE_W - MARGIN, font: bold, size: 10.5 });
    y -= 13;
    text(`${r.rateTitle} · ${occ(r.adults, r.children)}`, { size: 9, color: MUTED });
    y -= 17;
  }

  // ---- what the stay's value-added offers include ----
  // No amount column: these are free, and a money value beside them would read as
  // a charge. Straight from the booking's snapshot, so a printed confirmation says
  // what was promised even after the offer is edited or withdrawn.
  for (const va of b.valueAdds ?? []) {
    ensure(20);
    text((va.name || "Included").toUpperCase(), { size: 8.5, font: bold, color: MUTED });
    y -= 13;
    for (const inc of va.inclusions) {
      ensure(14);
      // A bullet, not the ✓ the email uses: U+2713 is NOT in the Noto Sans subset
      // this PDF embeds, and pdf-lib doesn't throw on a missing glyph — it draws a
      // .notdef box. Every line would have been prefixed with a black rectangle,
      // and nothing in the output size would have shown it. U+2022 is in the
      // subset (checked against the font), and matches the "·" used above.
      text(`•  ${inc}`, { size: 9.5 });
      y -= 13;
    }
    y -= 5;
  }

  // ---- extras ----
  for (const x of b.extras ?? []) {
    ensure(15);
    text(`${x.name}${x.optionName ? ` — ${x.optionName}` : ""}${x.qty > 1 ? ` ×${x.qty}` : ""}`, {
      size: 9.5,
      color: MUTED,
    });
    text(money(x.amount), { rightAt: PAGE_W - MARGIN, size: 10 });
    y -= 15;
  }

  // ---- taxes & fees charged on top (snapshotted at booking time) ----
  for (const c of [...(b.pricing?.charges ?? []), ...(b.pricing?.taxLines ?? [])]) {
    ensure(15);
    text(c.label, { size: 9.5, color: MUTED });
    text(money(c.amount), { rightAt: PAGE_W - MARGIN, size: 10 });
    y -= 15;
  }

  // ---- totals — mirror the email: captured money shows as Paid, not due ----
  rule(6, 14);
  const paid = b.payment?.mode === "payment" ? (b.payment.amount ?? 0) : 0;
  const dueNow = b.consent?.dueNow ?? 0;
  const dueAtHotel = Math.max(0, b.total - (paid > 0 ? paid : dueNow));
  ensure(20);
  text("Total", { font: bold, size: 12.5 });
  text(money(b.total), { rightAt: PAGE_W - MARGIN, font: bold, size: 12.5 });
  y -= 18;
  if (paid > 0) labelValue("Paid", money(paid));
  else if (dueNow > 0) labelValue("Due now", money(dueNow));
  if (dueAtHotel > 0) labelValue("Due at the hotel", money(dueAtHotel));
  const taxIncluded = b.pricing?.taxIncluded ?? 0;
  if (taxIncluded > 0) {
    ensure(13);
    text(`Includes ${money(taxIncluded)} VAT`, { rightAt: PAGE_W - MARGIN, size: 8.5, color: MUTED });
    y -= 13;
  }

  // ---- cancellation policy line ----
  const cancel = b.cancellation;
  const cancelLine = !cancel
    ? ""
    : cancel.refundable
      ? cancel.cancelByISO
        ? // The hotel's wall clock, not the server's UTC — same reason as the email.
          `Free cancellation until ${formatCancelDeadline({ iso: cancel.cancelByISO, local: cancel.cancelByLocal }, "d MMM yyyy")}`
        : "Free cancellation"
      : "Non-refundable";
  if (cancelLine) {
    ensure(15);
    y -= 4;
    text(cancelLine, { size: 9.5, color: MUTED });
    y -= 15;
  }

  // ---- special requests ----
  if (b.guest.requests) {
    ensure(30);
    y -= 6;
    text("Special requests", { size: 9.5, font: bold, color: MUTED });
    y -= 14;
    // Wrap with the same font the lines will be drawn in, or the measured
    // widths won't match the glyphs.
    for (const line of wrapText(b.guest.requests, fontFor(b.guest.requests, font), 9.5, CONTENT_W)) {
      ensure(13);
      text(line, { size: 9.5 });
      y -= 13;
    }
  }

  // ---- footer: hotel contact ----
  const footer = [hotelName, input.address, input.phone].filter(Boolean).join(" · ");
  page.drawLine({
    start: { x: MARGIN, y: MARGIN + 16 },
    end: { x: PAGE_W - MARGIN, y: MARGIN + 16 },
    thickness: 0.7,
    color: LINE,
  });
  page.drawText(footer, { x: MARGIN, y: MARGIN, size: 8.5, font: fontFor(footer, font), color: MUTED });

  return doc.save();
}
