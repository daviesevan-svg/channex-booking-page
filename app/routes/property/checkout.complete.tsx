import { redirect } from "react-router";

import type { Route } from "./+types/checkout.complete";
import { getBookings, type BookingRecord } from "~/lib/bookings.server";
import { deletePending, getPending } from "~/lib/pending-bookings.server";
import { finalizeBooking, paymentFromSession } from "~/lib/booking-finalize.server";
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
  const checkoutUrl = `/${pid}/checkout?${fwd.toString()}`;
  if (!ref || !sessionId) throw redirect(`/${pid}`);

  // Confirmation URL that tells the truth: a booking that failed to finalize
  // (Channex rejected it, or it sold out and was auto-refunded) must NOT land the
  // paid guest on a success page. Carry the outcome so confirmation can show it.
  const outcomeUrl = (rec: BookingRecord) => {
    const p = new URLSearchParams(fwd);
    if (rec.status === "failed") {
      p.set("status", "failed");
      if (rec.payment?.refund) p.set("refunded", "1");
    }
    return `/${pid}/confirmation/${ref}?${p.toString()}`;
  };

  // Webhook already finalized it → straight to the matching outcome.
  const already = (await getBookings(pid)).find((b) => b.reference === ref);
  if (already) {
    await deletePending(ref);
    throw redirect(outcomeUrl(already));
  }

  const pending = await getPending(ref);
  if (!pending) throw redirect(`/${pid}`); // expired / unknown

  let payment;
  try {
    const session = await retrieveCheckoutSession(pending.account, sessionId);
    payment = paymentFromSession(pending.account, sessionId, session);
  } catch {
    throw redirect(checkoutUrl);
  }

  if (!payment) throw redirect(checkoutUrl); // not completed (guest backed out)
  const record = await finalizeBooking(pending, payment, pending.origin);
  await deletePending(ref);
  throw redirect(outcomeUrl(record));
}

export default function CheckoutComplete() {
  return null; // loader always redirects
}
