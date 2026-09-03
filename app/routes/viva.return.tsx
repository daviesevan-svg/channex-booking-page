import { redirect } from "react-router";

import type { Route } from "./+types/viva.return";
import { getBookings, type BookingRecord } from "~/lib/bookings.server";
import { deletePending, getPending, getVivaOrder } from "~/lib/pending-bookings.server";
import { finalizeBooking, paymentFromVivaTransaction, rejectMismatchedVivaPayment } from "~/lib/booking-finalize.server";
import { SessionBindError } from "~/lib/stripe-session-bind";
import { getVivaConfig } from "~/lib/overrides.server";
import { retrieveVivaTransaction } from "~/lib/viva.server";
import { basePath, homePath } from "~/lib/base";

// Viva sends the guest here after paying. Unlike Stripe, the success URL is
// configured statically on the property's Viva payment source, so it can't
// carry our reference — the guest arrives with only ?s={orderCode}&t={txId},
// and the order-code mapping stashed at checkout finds the pending booking.
// The transaction is re-verified against Viva's API (the ?t= parameter is
// guest-controlled), then finalized exactly like the Stripe return URL —
// idempotent, because the webhook may have raced us.
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const orderCode = (url.searchParams.get("s") || "").replace(/\D/g, "");
  const transactionId = url.searchParams.get("t") || "";
  if (!orderCode) throw redirect("/");

  const order = await getVivaOrder(orderCode);
  if (!order) throw redirect("/"); // expired / unknown — nowhere better to send them

  const base = basePath(order.channel || undefined);
  const pending = await getPending(order.ref);
  const params = new URLSearchParams(pending?.returnParams ?? "");
  const outcomeUrl = (rec: BookingRecord) => {
    const p = new URLSearchParams(params);
    if (rec.status === "failed") {
      p.set("status", "failed");
      if (rec.payment?.refund) p.set("refunded", "1");
    }
    return `${base}/confirmation/${order.ref}?${p.toString()}`;
  };

  // Webhook already finalized it → straight to the matching outcome.
  const already = (await getBookings(order.pid)).find((b) => b.reference === order.ref);
  if (already) {
    await deletePending(order.ref);
    throw redirect(outcomeUrl(already));
  }
  if (!pending) throw redirect(homePath(order.channel || undefined)); // expired / unknown

  // Back to checkout with the guest's cart intact if the payment can't be
  // confirmed. `sim` is an outcome flag for the confirmation page, not a
  // checkout input — strip it.
  const back = new URLSearchParams(params);
  back.delete("sim");
  const checkoutUrl = `${base}/checkout?${back.toString()}`;
  if (!transactionId) throw redirect(checkoutUrl);

  const viva = await getVivaConfig(order.pid);
  if (!viva) throw redirect(checkoutUrl); // disconnected mid-checkout

  let payment;
  try {
    const tx = await retrieveVivaTransaction(viva, transactionId);
    payment = paymentFromVivaTransaction(viva, orderCode, transactionId, tx);
  } catch {
    throw redirect(checkoutUrl);
  }
  if (!payment) throw redirect(checkoutUrl); // not completed

  let record;
  try {
    record = await finalizeBooking(pending, payment, pending.origin);
  } catch (e) {
    if (e instanceof SessionBindError) {
      // The charge doesn't match the stay (amount/currency). Refund it rather
      // than keep it, then back to checkout with a notice — the guest must not
      // arrive at an empty form with their money silently gone.
      await rejectMismatchedVivaPayment(viva, payment, order.ref, e);
      back.set("notice", "refunded");
      throw redirect(`${base}/checkout?${back.toString()}`);
    }
    throw e;
  }
  await deletePending(order.ref);
  throw redirect(outcomeUrl(record));
}

export default function VivaReturn() {
  return null; // loader always redirects
}
