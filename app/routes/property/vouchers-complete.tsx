// Stripe sends the voucher buyer here after paying. Mirror of
// checkout.complete.tsx: confirm the session paid, finalize (idempotent — the
// webhook may have raced us), forward to the voucher page.
import { redirect } from "react-router";

import type { Route } from "./+types/vouchers-complete";
import { resolveRequestProperty } from "~/lib/property-scope.server";
import { deletePendingVoucher, getPendingVoucher } from "~/lib/pending-vouchers.server";
import { getVoucherByCode } from "~/lib/vouchers.server";
import { finalizeVoucherFromStripeSession } from "~/lib/voucher-purchase.server";
import { SessionBindError } from "~/lib/stripe-session-bind";
import { basePath } from "~/lib/base";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const channel = params.channelId;
  const pid = await resolveRequestProperty(channel, request);
  const ref = url.searchParams.get("ref") || "";
  const sessionId = url.searchParams.get("session_id") || "";
  if (!ref || !sessionId) throw redirect(`${basePath(channel)}/vouchers`);

  const pending = await getPendingVoucher(ref);
  // Expired/consumed stash: if the webhook finalized and cleaned up, the buyer
  // already has the email with the voucher link — the shop is the safe landing.
  if (!pending) throw redirect(`${basePath(channel)}/vouchers`);

  const voucherUrl = `${basePath(channel)}/voucher/${pending.record.code}?issued=1`;

  // Webhook already issued it → straight through.
  if (await getVoucherByCode(pid, pending.record.code)) {
    await deletePendingVoucher(ref);
    throw redirect(voucherUrl);
  }

  let issued;
  try {
    issued = await finalizeVoucherFromStripeSession(ref, sessionId);
  } catch (e) {
    if (e instanceof SessionBindError) console.error(`[vouchers.complete] ${e.message}`);
    throw redirect(`${basePath(channel)}/vouchers/${pending.record.productId}`);
  }
  if (!issued) throw redirect(`${basePath(channel)}/vouchers/${pending.record.productId}`);
  throw redirect(voucherUrl);
}

export default function VouchersComplete() {
  return null; // loader always redirects
}
