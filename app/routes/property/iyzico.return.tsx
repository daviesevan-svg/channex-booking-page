import { redirect } from "react-router";

import type { Route } from "./+types/iyzico.return";
import { getBookings, type BookingRecord } from "~/lib/bookings.server";
import { deletePending, getPending } from "~/lib/pending-bookings.server";
import { finalizeBooking, paymentFromIyzico, rejectMismatchedIyzicoPayment } from "~/lib/booking-finalize.server";
import { SessionBindError } from "~/lib/stripe-session-bind";
import { getIyzicoConfig } from "~/lib/overrides.server";
import { retrieveCheckoutForm } from "~/lib/iyzico.server";
import { basePath, homePath } from "~/lib/base";
import { resolveRequestProperty } from "~/lib/property-scope.server";

// Where iyzico sends the guest — and its notification — after the hosted form.
//
// The callback URL is given per request (unlike Viva's, which is fixed on the
// payment source), so it carries ?ref= and no order-code mapping is needed.
//
// iyzico documents this as an IPN to "the given callbackUrl" without saying how,
// and in practice it is a browser-driven form POST. Rather than guess, both
// verbs are handled and the token is read from the body OR the query — the
// shape of the request decides nothing, because none of it is trusted: the
// token is only a lookup key, and everything the booking is finalized against
// comes back from iyzico's own API.
async function handle(request: Request, params: { channelId?: string }): Promise<Response> {
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") || "";
  let token = url.searchParams.get("token") || "";
  if (request.method === "POST") {
    try {
      const form = await request.formData();
      token = String(form.get("token") ?? "") || token;
    } catch {
      // Not form-encoded — the query string is the fallback, and a missing
      // token is handled below like any other unfinishable return.
    }
  }
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

  // Already finalized (a retry, a refresh, a second delivery) → the matching
  // outcome, not a second charge.
  const already = (await getBookings(pid)).find((b) => b.reference === ref);
  if (already) {
    await deletePending(ref);
    throw redirect(outcomeUrl(already));
  }
  if (!pending) throw redirect(homePath(params.channelId));

  // Back to checkout with the cart intact when the payment can't be confirmed.
  // `sim` is an outcome flag for the confirmation page, not a checkout input.
  const back = new URLSearchParams(returnParams);
  back.delete("sim");
  const checkoutUrl = `${base}/checkout?${back.toString()}`;
  if (!token) throw redirect(checkoutUrl);

  const iyzico = await getIyzicoConfig(pid);
  if (!iyzico) throw redirect(checkoutUrl); // disconnected mid-checkout

  let payment;
  try {
    payment = paymentFromIyzico(iyzico, ref, await retrieveCheckoutForm(iyzico, token));
  } catch {
    throw redirect(checkoutUrl);
  }
  // Not paid, still under fraud review, unsigned, or a token belonging to some
  // other booking — all the same answer here: nothing is confirmed.
  if (!payment) throw redirect(checkoutUrl);

  let record;
  try {
    record = await finalizeBooking(pending, payment, pending.origin);
  } catch (e) {
    if (e instanceof SessionBindError) {
      // The charge doesn't match the stay. Refund it rather than keep it — the
      // guest must not land on an empty form with their money gone.
      await rejectMismatchedIyzicoPayment(iyzico, payment, ref, e);
      back.set("notice", "refunded");
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

export default function IyzicoReturn() {
  return null; // always redirects
}
