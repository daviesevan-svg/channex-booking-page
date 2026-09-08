import { redirect } from "react-router";

import type { Route } from "./+types/2c2p.return";
import { getBookingByReference, type BookingRecord } from "~/lib/bookings.server";
import { deletePending, getPending } from "~/lib/pending-bookings.server";
import { finalizeBooking, paymentFromC2p, rejectMismatchedC2pPayment } from "~/lib/booking-finalize.server";
import { SessionBindError } from "~/lib/stripe-session-bind";
import { getC2pConfig } from "~/lib/overrides.server";
import { inquireC2pPayment } from "~/lib/2c2p.server";
import { basePath, homePath } from "~/lib/base";
import { resolveRequestProperty } from "~/lib/property-scope.server";

// Where 2C2P sends the guest after its hosted page (frontendReturnUrl).
//
// The URL is given per payment, so it carries ?ref= and needs nothing
// configured on 2C2P's side. 2C2P also attaches the outcome to this request
// (respCode, invoiceNo…) — all of it ignored. Whatever arrives here was sent by
// a browser, on a request we did not make, so it decides nothing: the booking
// is finalized against 2C2P's own Payment Inquiry for OUR invoice number, or
// not at all. Both GET and POST are handled for the same reason — the shape of
// the return tells us nothing we would act on.
//
// The server-to-server notification lands on 2c2p.notify.tsx and finalizes the
// same way, so this leg is idempotent: whichever arrives second finds the
// booking already recorded and just redirects to it.
async function handle(request: Request, params: { channelId?: string }): Promise<Response> {
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") || "";
  if (!ref) throw redirect(homePath(params.channelId));

  const base = basePath(params.channelId);
  const pid = await resolveRequestProperty(params.channelId, request);
  const pending = await getPending(ref);
  const returnParams = new URLSearchParams(pending?.returnParams ?? "");

  const outcomeUrl = (rec: BookingRecord) => {
    const p = new URLSearchParams(returnParams);
    if (rec.status === "failed") {
      p.set("status", "failed");
      if (rec.payment?.refund) p.set("refunded", "1");
    }
    return `${base}/confirmation/${ref}?${p.toString()}`;
  };

  // Already finalized (the notification won the race, a refresh, a retry) →
  // the matching outcome, never a second booking.
  const already = await getBookingByReference(pid, ref);
  if (already) {
    await deletePending(ref);
    throw redirect(outcomeUrl(already));
  }
  if (!pending) throw redirect(homePath(params.channelId));

  // Back to checkout with the cart intact when the payment can't be confirmed
  // (cancelled on 2C2P's page, declined, still pending). `sim` is an outcome
  // flag for the confirmation page, not a checkout input.
  const back = new URLSearchParams(returnParams);
  back.delete("sim");
  const checkoutUrl = `${base}/checkout?${back.toString()}`;

  const c2p = await getC2pConfig(pid);
  if (!c2p) throw redirect(checkoutUrl); // disconnected mid-checkout

  let payment;
  try {
    payment = paymentFromC2p(c2p, ref, await inquireC2pPayment(c2p, ref));
  } catch {
    throw redirect(checkoutUrl);
  }
  if (!payment) throw redirect(checkoutUrl);

  let record;
  try {
    record = await finalizeBooking(pending, payment, pending.origin);
  } catch (e) {
    if (e instanceof SessionBindError) {
      // The charge doesn't match the stay. There is no refund API on this
      // gateway, so the money is flagged for the hotel and the guest is told
      // plainly — not "refunded", which would be untrue.
      await rejectMismatchedC2pPayment(c2p, payment, ref, e);
      back.set("notice", "held");
      throw redirect(`${base}/checkout?${back.toString()}`);
    }
    throw e;
  }
  await deletePending(ref);
  throw redirect(outcomeUrl(record));
}

export async function loader({ request, params }: Route.LoaderArgs) {
  return handle(request, params);
}

export async function action({ request, params }: Route.ActionArgs) {
  return handle(request, params);
}

export default function C2pReturn() {
  return null; // always redirects
}
