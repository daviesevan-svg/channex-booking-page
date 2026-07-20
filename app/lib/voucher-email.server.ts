// The voucher "keepsake" emails, recreated from the voucher-email design
// handoff: a table-based, email-safe layout (inlined styles, MSO fallbacks,
// no images) with a dark voucher panel as the centerpiece. One renderer serves
// the buyer receipt, the gift delivery to the recipient, and the reminder —
// cancel/host notifications stay on the plain renderSimpleEmail shell.
//
// The handoff's warm neutrals are kept as fixed email tokens (email clients
// can't consume the site's oklch theme variables); the property's brand shows
// through the accent, which replaces the design's terracotta everywhere.
import { format, parseISO } from "date-fns";

import { formatMoney } from "./money";
import type { VoucherRecord } from "./vouchers";

// Fixed palette from the design handoff (email-safe warm neutrals).
const BG = "#efe7da"; // page
const CREAM = "#f7f2ec"; // inset blocks
const CARD = "#fffdfa"; // main card
const INK = "#2a2521"; // primary text + dark panel fill
const BODY = "#3a332b"; // body text on cream
const MUTED = "#6f6557";
const MUTED2 = "#857a6c";
const FAINT = "#9a8f80";
const FAINTEST = "#b1a799";
const ON_DARK = "#fdf8f1";
const ON_DARK_TAN = "#c9a98e";
const ON_DARK_MUTED = "#8a7d68";
const BORDER_LIGHT = "#ece4d8";
const BORDER = "#e8dfd0";
const BORDER_WARM = "#e3d9c9";
const PANEL_ALT = "#3a352f";
const PANEL_BORDER = "#524b43";
const PANEL_DIVIDER = "#45403a";

const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "Arial,Helvetica,sans-serif";
const MONO = "'Courier New',Courier,monospace";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const spacer = (h: number) => `<div style="height:${h}px;line-height:${h}px;font-size:0;">&#8203;</div>`;

/** The rotated-square brand motif — an inline-block span holding size via a
 *  zero-width space (renders where images and icon fonts don't). */
const diamond = (size: number, accent: string, marginRight = 0) =>
  `<span style="display:inline-block;width:${size}px;height:${size}px;background:${accent};transform:rotate(45deg);border-radius:${size >= 9 ? 2 : 1}px;${marginRight ? `margin-right:${marginRight}px;` : ""}">&#8203;</span>`;

const label = (text: string, color: string, tracking = 0.12) =>
  `<div style="font-family:${SANS};font-size:11px;letter-spacing:${tracking}em;text-transform:uppercase;color:${color};font-weight:bold;">${esc(text)}</div>`;

/** Inline code pill used inside the how-to steps. */
const inlinePill = (code: string) =>
  `<span style="font-family:${MONO};background:${CREAM};border:1px solid ${BORDER};border-radius:5px;padding:2px 7px;color:${INK};">${esc(code)}</span>`;

const fmtLong = (iso: string) => {
  try {
    return format(parseISO(iso), "d MMMM yyyy");
  } catch {
    return iso.slice(0, 10);
  }
};
const fmtShort = (iso: string) => {
  try {
    return format(parseISO(iso), "d MMM yyyy");
  } catch {
    return iso.slice(0, 10);
  }
};

const KIND_LABEL: Record<VoucherRecord["kind"], string> = {
  gift: "Gift voucher",
  package: "Stay package",
  experience: "Experience",
};

export type VoucherEmailVariant = "receipt" | "gift" | "reminder";

interface Ctx {
  variant: VoucherEmailVariant;
  v: VoucherRecord;
  hotelName: string;
  accent: string;
  currency: string;
  voucherUrl: string;
  shopUrl: string;
}

/** Compose subject + HTML for one of the three voucher emails. */
export function composeVoucherEmail(ctx: Ctx): { subject: string; html: string } {
  const { variant, v, hotelName, accent, currency, voucherUrl } = ctx;
  const money = (n: number) => formatMoney(n, currency);
  const buyerFirst = v.buyer.name.trim().split(/\s+/)[0] || v.buyer.name;
  const recipient = v.gift?.recipientName?.trim();
  const recipientFirst = recipient ? recipient.split(/\s+/)[0] : undefined;
  const sentToRecipient = Boolean(v.gift?.recipientEmail);
  const what =
    v.kind === "gift" ? `a ${money(v.product.value ?? v.product.price)} gift voucher` : `“${v.product.title}”`;
  const validUntil = fmtLong(v.expiresAt);

  let subject: string;
  let preheader: string;
  let eyebrow: string;
  let heading: string; // \n becomes a <br>
  let intro: string;
  if (variant === "receipt") {
    subject = `Your ${hotelName} voucher — ${v.product.title}`;
    preheader = `Your ${hotelName} voucher is confirmed — ${v.product.title}. Everything you need is inside.`;
    eyebrow = "Order confirmed";
    heading = recipientFirst
      ? sentToRecipient
        ? `A gift for ${recipientFirst},\non its way.`
        : `A gift for ${recipientFirst},\nready to hand over.`
      : `Your voucher,\nready when you are.`;
    // Comp vouchers carry a placeholder buyer name ("Compliments of the
    // hotel") — greet without it.
    intro =
      (v.comp ? `This voucher comes with the compliments of ${hotelName}. ` : `Thank you, ${buyerFirst}. `) +
      (recipient
        ? sentToRecipient
          ? `We've emailed the voucher to ${recipient} (${v.gift!.recipientEmail}). Here's everything you'll both need.`
          : `Your voucher is below — pass the code to ${recipient} whenever the moment is right.`
        : `Your voucher is below. Keep the code safe — whoever holds it can use it.`);
  } else if (variant === "gift") {
    subject = v.comp ? `A gift from ${hotelName} 🎁` : `${v.buyer.name} sent you a gift from ${hotelName} 🎁`;
    preheader = `${v.comp ? hotelName : v.buyer.name} sent you a gift from ${hotelName} — your voucher and code are inside.`;
    eyebrow = "A gift for you";
    heading = v.comp ? `A little something,\nwith our compliments.` : `${buyerFirst} sent you\na little something.`;
    intro = v.comp
      ? `Hello${recipientFirst ? ` ${recipientFirst}` : ""} — ${hotelName} has sent you ${what}, with their compliments. Everything you need is below.`
      : `Hello${recipientFirst ? ` ${recipientFirst}` : ""} — ${v.buyer.name} has bought you ${what} at ${hotelName}. Everything you need is below.`;
  } else {
    subject = `A little reminder — your ${hotelName} gift is waiting 🎁`;
    preheader = `Your ${hotelName} gift is still waiting — voucher code inside.`;
    eyebrow = "A little reminder";
    heading = `Your gift is still\nwaiting for you.`;
    intro = `Just a friendly nudge: ${v.comp ? hotelName : v.buyer.name} sent you ${what}, and it's still waiting to be used.`;
  }

  // ---- the dark voucher panel ----
  const pkg = v.product.package;
  const stayFacts = pkg
    ? `${pkg.nights} night${pkg.nights === 1 ? "" : "s"} · ${pkg.adults} adult${pkg.adults === 1 ? "" : "s"}${pkg.children ? `, ${pkg.children} child${pkg.children === 1 ? "" : "ren"}` : ""}`
    : "";
  // Whole amounts drop the cents in the big display value ("£100", per the
  // design's "€350") but keep them everywhere money is transactional.
  const giftValue = v.product.value ?? v.product.price;
  const displayValue = (() => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: Number.isInteger(giftValue) ? 0 : 2,
      }).format(giftValue);
    } catch {
      return money(giftValue);
    }
  })();
  const leftFact =
    v.kind === "gift"
      ? {
          label: "Value",
          html: `<div class="voucher-val" style="font-family:${SERIF};font-size:48px;line-height:1;color:${ON_DARK};">${esc(displayValue)}</div>`,
        }
      : v.kind === "package"
        ? {
            label: "The stay",
            html: `<div style="font-family:${SERIF};font-size:22px;line-height:1.2;color:${ON_DARK};">${esc(stayFacts)}</div>`,
          }
        : v.product.guests
          ? {
              label: "For",
              html: `<div style="font-family:${SERIF};font-size:22px;line-height:1.2;color:${ON_DARK};">${esc(`${v.product.guests} guest${v.product.guests === 1 ? "" : "s"}`)}</div>`,
            }
          : {
              label: "Valid until",
              html: `<div style="font-family:${SERIF};font-size:22px;line-height:1.2;color:${ON_DARK};">${esc(validUntil)}</div>`,
            };

  const toFromRow = v.gift
    ? `${spacer(24)}
       <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
       <tr>
         <td align="left" width="50%">${label("To", ON_DARK_MUTED)}${spacer(4)}
           <div style="font-family:${SERIF};font-size:18px;color:${ON_DARK};">${esc(v.gift.recipientName)}</div></td>
         <td align="left" width="50%">${label("From", ON_DARK_MUTED)}${spacer(4)}
           <div style="font-family:${SERIF};font-size:18px;color:${ON_DARK};">${esc(v.buyer.name)}</div></td>
       </tr>
       </table>`
    : "";

  const panel = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${INK};border-radius:16px;">
    <tr><td style="padding:32px 34px 30px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="left" style="font-family:${SANS};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${ON_DARK_TAN};font-weight:bold;">${diamond(8, accent, 7)}${esc(hotelName)}</td>
        <td align="right" style="font-family:${SANS};font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${ON_DARK_MUTED};font-weight:bold;">${esc(KIND_LABEL[v.kind])}</td>
      </tr>
      </table>
      ${spacer(26)}
      <div style="font-family:${SERIF};font-size:34px;line-height:1.05;letter-spacing:-0.01em;color:${ON_DARK};">${esc(v.product.title)}</div>
      ${spacer(22)}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td class="stack" align="left" valign="bottom" style="border-top:1px solid ${PANEL_DIVIDER};padding-top:20px;">
          ${label(leftFact.label, ON_DARK_MUTED)}${spacer(6)}${leftFact.html}
        </td>
        <td class="stack stack-b" align="right" valign="bottom" style="border-top:1px solid ${PANEL_DIVIDER};padding-top:20px;">
          ${label("Voucher code", ON_DARK_MUTED)}${spacer(8)}
          <div style="font-family:${MONO};font-size:17px;letter-spacing:0.14em;color:${ON_DARK};background:${PANEL_ALT};border:1px solid ${PANEL_BORDER};border-radius:8px;padding:9px 14px;display:inline-block;white-space:nowrap;">${esc(v.code)}</div>
        </td>
      </tr>
      </table>
      ${toFromRow}
    </td></tr>
    </table>`;

  // ---- personal message ----
  const messageBlock = v.gift?.message
    ? `<tr><td class="px" style="padding:24px 48px 0;">
         <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CREAM};border-radius:12px;">
         <tr><td style="padding:20px 24px;">
           ${label(variant === "receipt" ? `Your message to ${recipientFirst ?? "them"}` : `A message from ${v.comp ? hotelName : buyerFirst}`, FAINT)}
           ${spacer(8)}
           <div style="font-family:${SERIF};font-size:17px;line-height:1.55;color:${BODY};font-style:italic;">&#8220;${esc(v.gift.message)}&#8221;</div>
         </td></tr>
         </table>
       </td></tr>`
    : "";

  // ---- what's included ----
  const included = v.product.included?.filter((s) => s.trim()) ?? [];
  const includedBlock = included.length
    ? `<tr><td class="px" style="padding:34px 48px 4px;">
         <div style="font-family:${SERIF};font-size:22px;letter-spacing:-0.01em;color:${INK};">What's included</div>
         ${spacer(18)}
         <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
         ${included
           .map(
             (item, i) => `<tr>
           <td width="26" valign="top" style="padding:2px 0;">${diamond(7, accent)}</td>
           <td style="font-family:${SANS};font-size:15px;line-height:1.5;color:${BODY};padding-bottom:${i === included.length - 1 ? 2 : 12}px;">${esc(item)}</td>
         </tr>`,
           )
           .join("")}
         </table>
       </td></tr>`
    : "";

  // ---- CTA ----
  const ctaLabel =
    variant === "receipt"
      ? "View the voucher"
      : v.kind === "package"
        ? "Redeem & book the dates"
        : "View your voucher";
  const ctaBlock = `
    <tr><td class="px" style="padding:30px 48px 6px;" align="center">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(voucherUrl)}" style="height:52px;v-text-anchor:middle;width:280px;" arcsize="20%" strokecolor="${accent}" fillcolor="${accent}">
      <w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${esc(ctaLabel)}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr><td align="center" bgcolor="${accent}" style="border-radius:10px;">
        <a href="${esc(voucherUrl)}" style="display:block;font-family:${SANS};font-size:15px;font-weight:bold;color:#ffffff;padding:16px 40px;border-radius:10px;text-decoration:none;">${esc(ctaLabel)} &#8594;</a>
      </td></tr>
      </table>
      <!--<![endif]-->
      ${spacer(12)}
      <div style="font-family:${SANS};font-size:13px;color:${FAINT};">Valid until <strong style="color:${MUTED};">${esc(validUntil)}</strong></div>
    </td></tr>`;

  // ---- how it's redeemed ----
  const howHeading =
    variant === "receipt" && recipientFirst ? `How ${recipientFirst} redeems it` : "How to redeem it";
  const steps =
    v.kind === "package"
      ? [
          `Open the voucher page for ${inlinePill(v.code)} and pick a check-in date — only dates the package allows are shown, with live availability.`,
          `Choose a room and add the guest details — no payment needed, the stay is covered.`,
          `That's it — the booking confirms instantly and the confirmation arrives by email.`,
        ]
      : v.kind === "gift"
        ? [
            `Book online at ${esc(hotelName)} as usual — any room, any dates.`,
            `Enter code ${inlinePill(v.code)} at checkout — the value comes straight off the amount due.`,
            `Anything left over stays on the voucher for next time.`,
          ]
        : [
            `Get in touch with ${esc(hotelName)} to arrange a date, if one's needed.`,
            `Present code ${inlinePill(v.code)} on arrival — the team will mark it redeemed.`,
            `Enjoy — it's already paid for.`,
          ];
  const howBlock = `
    <tr><td class="px" style="padding:32px 48px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid ${BORDER_LIGHT};">
      <tr><td style="height:28px;line-height:28px;font-size:0;">&#8203;</td></tr>
      <tr><td>
        <div style="font-family:${SERIF};font-size:22px;letter-spacing:-0.01em;color:${INK};">${esc(howHeading)}</div>
        ${spacer(18)}
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${steps
          .map(
            (step, i) => `<tr>
          <td width="40" valign="top"><div style="font-family:${SERIF};font-size:19px;color:${accent};">${i + 1}.</div></td>
          <td style="font-family:${SANS};font-size:14.5px;line-height:1.5;color:${BODY};padding-bottom:${i === steps.length - 1 ? 2 : 14}px;">${step}</td>
        </tr>`,
          )
          .join("")}
        </table>
      </td></tr>
      </table>
    </td></tr>`;

  // ---- order summary (buyer receipt only) ----
  const paidLabel = v.comp
    ? "Complimentary"
    : v.simulated
      ? "Test — no charge"
      : money(v.payment?.amount ?? v.product.price);
  const summaryBlock =
    variant === "receipt"
      ? `<tr><td class="px" style="padding:30px 48px 40px;">
           <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CREAM};border:1px solid ${BORDER_LIGHT};border-radius:12px;">
           <tr><td style="padding:22px 24px;">
             ${label("Order summary", FAINT, 0.14)}
             ${spacer(16)}
             <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
             <tr>
               <td style="font-family:${SANS};font-size:14px;color:${BODY};padding-bottom:8px;">${esc(`${v.product.title} — ${KIND_LABEL[v.kind].toLowerCase()}`)}</td>
               <td align="right" style="font-family:${SANS};font-size:14px;color:${BODY};padding-bottom:8px;">${esc(v.comp || v.simulated ? "—" : money(v.product.price))}</td>
             </tr>
             <tr>
               <td style="font-family:${SANS};font-size:14px;color:${MUTED};padding-bottom:12px;">Digital delivery</td>
               <td align="right" style="font-family:${SANS};font-size:14px;color:${MUTED};padding-bottom:12px;">Free</td>
             </tr>
             <tr>
               <td style="border-top:1px solid ${BORDER_WARM};padding-top:12px;"><span style="font-family:${SERIF};font-size:16px;color:${INK};">Total paid</span></td>
               <td align="right" style="border-top:1px solid ${BORDER_WARM};padding-top:12px;"><span style="font-family:${SERIF};font-size:16px;color:${INK};font-weight:bold;">${esc(paidLabel)}</span></td>
             </tr>
             </table>
             ${spacer(16)}
             <div style="font-family:${SANS};font-size:12.5px;line-height:1.5;color:${FAINT};">Voucher <strong style="color:${MUTED};">${esc(v.code)}</strong> &#183; Purchased ${esc(fmtShort(v.purchasedAt))}${sentToRecipient ? ` &#183; Sent to ${esc(v.gift!.recipientEmail!)}` : ""}</div>
           </td></tr>
           </table>
         </td></tr>`
      : `<tr><td style="height:40px;line-height:40px;font-size:0;">&#8203;</td></tr>`;

  // ---- below the card ----
  const crossSell =
    variant === "receipt"
      ? `<tr><td class="px" style="padding:22px 20px 4px;" align="center">
           <div style="font-family:${SANS};font-size:13px;line-height:1.6;color:${MUTED2};">
             Looking for another gift? Browse all <a href="${esc(ctx.shopUrl)}" style="color:${accent};font-weight:bold;text-decoration:none;">${esc(hotelName)} vouchers</a>.
           </div>
         </td></tr>`
      : "";
  const complianceLine =
    variant === "receipt"
      ? `You're receiving this because you bought a voucher from ${hotelName}.`
      : v.comp
        ? `You're receiving this because ${hotelName} sent you a gift.`
        : `You're receiving this because ${v.buyer.name} sent you a gift via ${hotelName}.`;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<!--[if mso]>
<style>*{font-family:Georgia,'Times New Roman',serif !important;} .body-font{font-family:Arial,Helvetica,sans-serif !important;}</style>
<![endif]-->
<style>
  body{margin:0;padding:0;width:100%;background:${BG};}
  table{border-collapse:collapse;}
  a{text-decoration:none;}
  @media only screen and (max-width:600px){
    .container{width:100% !important;}
    .px{padding-left:24px !important;padding-right:24px !important;}
    .voucher-val{font-size:44px !important;}
    .hero-h{font-size:30px !important;}
    .stack{display:block !important;width:100% !important;text-align:left !important;}
    .stack-b{border-top:none !important;padding-top:18px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BG};">

<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BG};opacity:0;">
  ${esc(preheader)} &#8202;${"&#8203;".repeat(12)}
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};">
<tr>
<td align="center" style="padding:28px 12px 40px;">

  <!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"><tr><td><![endif]-->
  <table role="presentation" class="container" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;">

    <tr>
    <td class="px" style="padding:6px 16px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="left" style="font-family:${SERIF};font-size:20px;font-weight:bold;color:${INK};letter-spacing:-0.01em;">${diamond(11, accent, 9)}${esc(hotelName)}</td>
        <td align="right" style="font-family:${SANS};font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:${FAINT};font-weight:bold;">${esc(KIND_LABEL[v.kind])}</td>
      </tr>
      </table>
    </td>
    </tr>

    <tr>
    <td>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CARD};border:1px solid ${BORDER};border-radius:20px;overflow:hidden;">

        <tr>
        <td class="px" style="padding:44px 48px 8px;" align="center">
          <div style="font-family:${SANS};font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:${accent};font-weight:bold;">${esc(eyebrow)}</div>
          ${spacer(14)}
          <h1 class="hero-h" style="margin:0;font-family:${SERIF};font-weight:normal;font-size:36px;line-height:1.1;letter-spacing:-0.02em;color:${INK};">${esc(heading).replace(/\n/g, "<br>")}</h1>
          ${spacer(16)}
          <p style="margin:0 auto;max-width:400px;font-family:${SANS};font-size:15px;line-height:1.65;color:${MUTED};">${esc(intro)}</p>
        </td>
        </tr>

        <tr><td style="height:34px;line-height:34px;font-size:0;">&#8203;</td></tr>

        <tr>
        <td class="px" style="padding:0 40px;">
          ${panel}
        </td>
        </tr>

        ${messageBlock}
        ${includedBlock}
        ${ctaBlock}
        ${howBlock}
        ${summaryBlock}

      </table>
    </td>
    </tr>

    ${crossSell}

    <tr>
    <td class="px" style="padding:26px 24px 8px;" align="center">
      <div style="font-family:${SERIF};font-size:16px;font-weight:bold;color:${INK};">${diamond(9, accent, 8)}${esc(hotelName)}</div>
      ${spacer(12)}
      <div style="font-family:${SANS};font-size:12px;line-height:1.7;color:${FAINT};">
        <a href="${esc(voucherUrl)}" style="color:${MUTED2};text-decoration:underline;">View this voucher online</a>
      </div>
      ${spacer(14)}
      <div style="font-family:${SANS};font-size:11px;color:${FAINTEST};">${esc(complianceLine)}</div>
    </td>
    </tr>

  </table>
  <!--[if mso]></td></tr></table><![endif]-->

</td>
</tr>
</table>

</body>
</html>`;

  return { subject, html };
}
