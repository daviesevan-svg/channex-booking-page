import type { Route } from "./+types/api.stripe-webhook";
import { getConfig } from "~/lib/config.server";
import { verifyWebhook } from "~/lib/stripe.server";
import { finalizeFromStripeSession } from "~/lib/booking-finalize.server";
import { finalizeVoucherFromStripeSession } from "~/lib/voucher-purchase.server";

interface StripeEvent {
  type?: string;
  data?: { object?: Record<string, unknown> };
}

// POST /api/stripe-webhook — Stripe's authoritative payment confirmation. The
// return URL usually finalizes first; this is the backstop if the guest closes
// the tab. finalizeBooking is idempotent by reference, so double-firing is safe.
export async function action({ request }: Route.ActionArgs) {
  const raw = await request.text();
  const sig = request.headers.get("stripe-signature");
  const secret = getConfig().stripeWebhookSecret ?? "";

  let event: StripeEvent;
  try {
    event = (await verifyWebhook(raw, sig, secret, Math.floor(Date.now() / 1000))) as StripeEvent;
  } catch {
    return new Response("invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data?.object ?? {};
    const ref = typeof s.client_reference_id === "string" ? s.client_reference_id : "";
    const sessionId = typeof s.id === "string" ? s.id : "";
    const meta = (s.metadata ?? {}) as Record<string, unknown>;
    // Re-fetch the session on the connected account for authoritative status +
    // card details. Idempotent finalize handles a race with the return URL.
    // Voucher purchases and bookings share this webhook — session metadata
    // says which finalize path owns the reference.
    if (ref && sessionId) {
      if (meta.kind === "voucher") await finalizeVoucherFromStripeSession(ref, sessionId);
      else await finalizeFromStripeSession(ref, sessionId);
    }
  }
  return Response.json({ received: true });
}

// Not part of the contract; respond clearly to a stray GET.
export function loader() {
  return Response.json({ ok: false, error: "POST webhooks here" }, { status: 405 });
}
