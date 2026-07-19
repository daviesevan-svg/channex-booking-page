// The voucher as a printable/giftable PDF — same in-Worker pdf-lib approach as
// booking-pdf.server.ts (no headless browser), same embedded Noto Sans subset
// so names and messages in Latin/Greek/Cyrillic render properly.
import { PDFDocument, PDFFont, rgb, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { WEEKDAY_LABELS, type VoucherRecord } from "./vouchers";
import { formatMoney } from "./money";
import notoSansRegularB64 from "./fonts/noto-sans-regular";
import notoSansBoldB64 from "./fonts/noto-sans-bold";

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 52;

const INK = rgb(0.12, 0.12, 0.12);
const MUTED = rgb(0.54, 0.54, 0.54);
const LINE = rgb(0.9, 0.88, 0.85);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
let fontBytes: { regular: Uint8Array; bold: Uint8Array } | null = null;
const getFontBytes = () => (fontBytes ??= { regular: b64ToBytes(notoSansRegularB64), bold: b64ToBytes(notoSansBoldB64) });

function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return rgb(0.75, 0.35, 0.24);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

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

export interface VoucherPdfInput {
  voucher: VoucherRecord;
  hotelName: string;
  accent: string;
  currency: string;
  /** Absolute URL of the voucher page (redeem entry point). */
  voucherUrl: string;
}

export async function renderVoucherPdf(input: VoucherPdfInput): Promise<Uint8Array> {
  const { voucher: v, hotelName, currency } = input;
  const accent = hexToRgb(input.accent);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bytes = getFontBytes();
  const font = await doc.embedFont(bytes.regular, { subset: true });
  const bold = await doc.embedFont(bytes.bold, { subset: true });
  doc.setTitle(`${hotelName} voucher ${v.code}`);

  const page = doc.addPage([PAGE_W, PAGE_H]);
  const money = (n: number) => formatMoney(n, currency);
  let y = PAGE_H;

  const text = (s: string, opts: { size?: number; font?: PDFFont; color?: RGB; x?: number; center?: boolean } = {}) => {
    const f = opts.font ?? font;
    const size = opts.size ?? 11;
    const x = opts.center ? (PAGE_W - f.widthOfTextAtSize(s, size)) / 2 : (opts.x ?? MARGIN);
    page.drawText(s, { x, y, size, font: f, color: opts.color ?? INK });
  };

  // Header band.
  page.drawRectangle({ x: 0, y: PAGE_H - 90, width: PAGE_W, height: 90, color: accent });
  y = PAGE_H - 56;
  text(hotelName, { size: 20, font: bold, color: rgb(1, 1, 1), center: true });

  y = PAGE_H - 150;
  text(v.kind === "gift" ? "GIFT VOUCHER" : v.kind === "package" ? "STAY PACKAGE" : "EXPERIENCE VOUCHER", { size: 12, color: MUTED, center: true });
  y -= 30;
  text(v.product.title, { size: 24, font: bold, center: true });

  if (v.kind === "gift") {
    y -= 34;
    text(money(v.product.value ?? v.product.price), { size: 30, font: bold, color: accent, center: true });
  }

  // Gift message.
  if (v.gift) {
    y -= 32;
    text(`For ${v.gift.recipientName}, from ${v.buyer.name}`, { size: 11.5, color: MUTED, center: true });
    if (v.gift.message) {
      y -= 18;
      for (const line of wrap(`“${v.gift.message}”`, font, 11.5, PAGE_W - MARGIN * 2 - 60)) {
        text(line, { size: 11.5, center: true });
        y -= 15;
      }
      y += 15;
    }
  }

  // The code, boxed.
  y -= 52;
  const codeSize = 26;
  const codeW = bold.widthOfTextAtSize(v.code, codeSize);
  page.drawRectangle({
    x: (PAGE_W - codeW - 56) / 2,
    y: y - 18,
    width: codeW + 56,
    height: 54,
    borderColor: accent,
    borderWidth: 1.5,
    color: rgb(0.985, 0.975, 0.96),
  });
  text(v.code, { size: codeSize, font: bold, center: true });

  // Package summary.
  if (v.kind === "package" && v.product.package) {
    const p = v.product.package;
    y -= 56;
    const guests = `${p.adults} adult${p.adults === 1 ? "" : "s"}${p.children ? ` + ${p.children} child${p.children === 1 ? "" : "ren"}` : ""}`;
    text(`${p.nights} night${p.nights === 1 ? "" : "s"} · ${guests}`, { size: 13, font: bold, center: true });
    if (v.product.roomTitles?.length) {
      y -= 17;
      text(v.product.roomTitles.join(" or "), { size: 11, color: MUTED, center: true });
    }
    const rules: string[] = [];
    if (p.checkinDays.length) rules.push(`Check-in ${p.checkinDays.map((d) => WEEKDAY_LABELS[d]).join("/")}`);
    if (p.window?.from || p.window?.to) rules.push(`Stays ${p.window.from ?? "…"} – ${p.window.to ?? "…"}`);
    if (rules.length) {
      y -= 16;
      text(rules.join(" · "), { size: 10.5, color: MUTED, center: true });
    }
    y -= 24;
    text("Book your stay online — no phone call needed:", { size: 10.5, color: MUTED, center: true });
    y -= 15;
    text(input.voucherUrl, { size: 10.5, color: accent, center: true });
  } else if (v.kind === "experience") {
    y -= 56;
    if (v.product.guests != null) {
      text(`For ${v.product.guests} guest${v.product.guests === 1 ? "" : "s"}`, { size: 13, font: bold, center: true });
      y -= 20;
    }
    text("Present this code at the hotel to redeem:", { size: 10.5, color: MUTED, center: true });
    y -= 15;
    text(input.voucherUrl, { size: 10.5, color: accent, center: true });
  } else {
    y -= 56;
    text("Redeem at checkout on our booking page, or present at the hotel:", { size: 10.5, color: MUTED, center: true });
    y -= 15;
    text(input.voucherUrl, { size: 10.5, color: accent, center: true });
  }

  // Validity + terms.
  y -= 34;
  text(`Valid until ${v.expiresAt.slice(0, 10)}`, { size: 10.5, font: bold, center: true });
  if (v.product.terms) {
    y -= 20;
    for (const line of wrap(v.product.terms, font, 9, PAGE_W - MARGIN * 2)) {
      text(line, { size: 9, color: MUTED, center: true });
      y -= 12;
    }
  }

  // Footer.
  page.drawLine({ start: { x: MARGIN, y: MARGIN + 16 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 16 }, thickness: 0.7, color: LINE });
  page.drawText(hotelName, { x: MARGIN, y: MARGIN, size: 8.5, font, color: MUTED });
  const ref = `Voucher ${v.code} · purchased ${v.purchasedAt.slice(0, 10)}`;
  page.drawText(ref, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(ref, 8.5), y: MARGIN, size: 8.5, font, color: MUTED });

  return doc.save();
}
