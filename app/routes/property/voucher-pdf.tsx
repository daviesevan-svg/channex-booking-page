// Resource route: the voucher as a downloadable PDF (print it, gift it).
// The unguessable code is the credential — same model as the voucher page.
import type { Route } from "./+types/voucher-pdf";

import { getOverrides, getSettings } from "~/lib/overrides.server";
import { lookupVoucherGuarded } from "~/lib/vouchers.server";
import { normalizeVoucherCode } from "~/lib/vouchers";
import { accentHex } from "~/lib/email-render.server";
import { renderVoucherPdf } from "~/lib/voucher-pdf.server";
import { basePath } from "~/lib/base";
import { resolveRequestProperty } from "~/lib/property-scope.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const base = basePath(params.channelId);
  const pid = await resolveRequestProperty(params.channelId, request);
  const voucher = await lookupVoucherGuarded(pid, params.code, request);
  if (voucher === "limited") throw new Response("Too many attempts — try again shortly.", { status: 429 });
  if (!voucher) throw new Response("Voucher not found", { status: 404 });

  const [settings, ov] = await Promise.all([getSettings(pid), getOverrides(pid)]);
  const origin = new URL(request.url).origin;
  const bytes = await renderVoucherPdf({
    voucher,
    hotelName: ov.hotelName || "Your hotel",
    accent: accentHex(settings),
    currency: settings.currency || "GBP",
    voucherUrl: `${origin}${base}/voucher/${voucher.code}`,
  });
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "X-Robots-Tag": "noindex",
      "Content-Disposition": `attachment; filename="voucher-${voucher.code}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
