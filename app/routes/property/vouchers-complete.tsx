// Stripe sends the voucher buyer here after paying. Mirror of
// checkout.complete.tsx: confirm the session paid, finalize (idempotent — the
// webhook may have raced us), forward to the voucher page.
import { redirect } from "react-router";

import type { Route } from "./+types/vouchers-complete";
import { resolvePropertyId } from "~/lib/properties.server";
import { deletePendingVoucher, getPendingVoucher } from "~/lib/pending-vouchers.server";
import { getVoucherByCode } from "~/lib/vouchers.server";
import { finalizeVoucher } from "~/lib/voucher-purchase.server";
import { paymentFromSession } from "~/lib/booking-finalize.server";
import { retrieveCheckoutSession } from "~/lib/stripe.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const channel = params.channelId;
  const pid = await resolvePropertyId(channel);
  const ref = url.searchParams.get("ref") || "";
  const sessionId = url.searchParams.get("session_id") || "";
  if (!ref || !sessionId) throw redirect(`/${channel}/vouchers`);

  const pending = await getPendingVoucher(ref);
  // Expired/consumed stash: if the webhook finalized and cleaned up, the buyer
  // already has the email with the voucher link — the shop is the safe landing.
  if (!pending) throw redirect(`/${channel}/vouchers`);

  const voucherUrl = `/${channel}/voucher/${pending.record.code}?issued=1`;

  // Webhook already issued it → straight through.
  if (await getVoucherByCode(pid, pending.record.code)) {
    await deletePendingVoucher(ref);
    throw redirect(voucherUrl);
  }

  let payment;
  try {
    const session = await retrieveCheckoutSession(pending.account, sessionId);
    payment = paymentFromSession(pending.account, sessionId, session);
  } catch {
    throw redirect(`/${channel}/vouchers/${pending.record.productId}`);
  }
  if (!payment || payment.mode !== "payment") {
    // Not completed (buyer backed out) — back to the product page.
    throw redirect(`/${channel}/vouchers/${pending.record.productId}`);
  }

  await finalizeVoucher(pending, payment);
  await deletePendingVoucher(ref);
  throw redirect(voucherUrl);
}

export default function VouchersComplete() {
  return null; // loader always redirects
}
