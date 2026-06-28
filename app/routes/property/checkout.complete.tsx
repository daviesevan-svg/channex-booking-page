import { redirect } from "react-router";

import type { Route } from "./+types/checkout.complete";
import { getBookings, type PaymentInfo } from "~/lib/bookings.server";
import { deletePending, getPending } from "~/lib/pending-bookings.server";
import { finalizeBooking } from "~/lib/booking-finalize.server";
import { retrieveCheckoutSession } from "~/lib/stripe.server";

// Stripe sends the guest here after paying. We retrieve the session to confirm
// payment, finalize the booking (idempotent — the webhook may have raced us),
// and forward to the confirmation page. The cart params ride along on the URL so
// confirmation can render even if the webhook finalized first.
export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const pid = params.channelId;
  const ref = url.searchParams.get("ref") || "";
  const sessionId = url.searchParams.get("session_id") || "";

  const fwd = new URLSearchParams(url.searchParams);
  fwd.delete("session_id");
  fwd.delete("ref");
  const confirmationUrl = `/${pid}/confirmation/${ref}?${fwd.toString()}`;
  const checkoutUrl = `/${pid}/checkout?${fwd.toString()}`;
  if (!ref || !sessionId) throw redirect(`/${pid}`);

  // Webhook already finalized it → straight to confirmation.
  const already = (await getBookings(pid)).find((b) => b.reference === ref);
  if (already) {
    await deletePending(ref);
    throw redirect(confirmationUrl);
  }

  const pending = await getPending(ref);
  if (!pending) throw redirect(`/${pid}`); // expired / unknown

  let payment: PaymentInfo | undefined;
  try {
    const session = await retrieveCheckoutSession(pending.account, sessionId);
    if (session.payment_status === "paid") {
      const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      payment = {
        provider: "stripe",
        mode: "payment",
        accountId: pending.account,
        sessionId,
        amount: (session.amount_total ?? 0) / 100,
        currency: (session.currency ?? pending.record.currency).toUpperCase(),
        paymentIntentId: pi,
      };
    }
  } catch {
    throw redirect(checkoutUrl);
  }

  if (!payment) throw redirect(checkoutUrl); // not paid (guest backed out)
  await finalizeBooking(pending, payment, pending.origin);
  await deletePending(ref);
  throw redirect(confirmationUrl);
}

export default function CheckoutComplete() {
  return null; // loader always redirects
}
