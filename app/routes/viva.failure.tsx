import { redirect } from "react-router";

import type { Route } from "./+types/viva.failure";
import { getPending, getVivaOrder } from "~/lib/pending-bookings.server";
import { basePath } from "~/lib/base";

// Viva's failure URL — the guest declined/failed payment on the hosted page (or
// pressed Cancel). Mirrors Stripe's cancel_url: back to checkout with the cart
// intact so they can try again. Any gift-voucher hold stays until its TTL, same
// as a Stripe back-out.
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const orderCode = (url.searchParams.get("s") || "").replace(/\D/g, "");
  const order = orderCode ? await getVivaOrder(orderCode) : null;
  if (!order) throw redirect("/");

  const pending = await getPending(order.ref);
  const back = new URLSearchParams(pending?.returnParams ?? "");
  back.delete("sim"); // an outcome flag for the confirmation page, not a checkout input
  throw redirect(`${basePath(order.channel || undefined)}/checkout?${back.toString()}`);
}

export default function VivaFailure() {
  return null; // loader always redirects
}
