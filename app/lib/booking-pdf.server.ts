// Booking confirmation as a downloadable PDF — for hotels to print or forward
// manually when the guest didn't receive the confirmation email. Generated
// with pdf-lib (pure JS, no headless browser in a Worker) and mirrors the
// email's details block: stay dates, rooms, extras, taxes & fees, totals,
// cancellation line. Text uses an embedded Noto Sans subset (Latin + Greek +
// Cyrillic), so guest names like "Νίκος" or "Дмитрий" render properly —
// pdf-lib's standard fonts are WinAnsi-only.
import { PDFDocument, PDFFont, PDFPage, rgb, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { format, parseISO } from "date-fns";

import type { BookingRecord } from "./bookings.server";
import { formatMoney } from "./money";
import notoSansRegularB64 from "./fonts/noto-sans-regular";
import notoSansBoldB64 from "./fonts/noto-sans-bold";

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.12, 0.12, 0.12);
const MUTED = rgb(0.54, 0.54, 0.54);
const LINE = rgb(0.9, 0.88, 0.85);

// The subsetted Noto Sans TTFs, base64-inlined (~119 KB each). Decoded once
// per isolate and reused across renders.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
let fontBytes: { regular: Uint8Array; bold: Uint8Array } | null = null;
function getFontBytes() {
  fontBytes ??= { regular: b64ToBytes(notoSansRegularB64), bold: b64ToBytes(notoSansBoldB64) };
  return fontBytes;
}

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

/** Greedy word-wrap for a proportional font. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

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
  // subset: true → only the glyphs actually used are embedded in the PDF, so
  // the download stays small despite the full LGC coverage in the source font.
  const bytes = getFontBytes();
  const font = await doc.embedFont(bytes.regular, { subset: true });
  const bold = await doc.embedFont(bytes.bold, { subset: true });
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
    const f = opts.font ?? font;
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
        ? `Free cancellation until ${fmtDateTime(cancel.cancelByISO)}`
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
    for (const line of wrap(b.guest.requests, font, 9.5, CONTENT_W)) {
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
  page.drawText(footer, { x: MARGIN, y: MARGIN, size: 8.5, font, color: MUTED });

  return doc.save();
}
