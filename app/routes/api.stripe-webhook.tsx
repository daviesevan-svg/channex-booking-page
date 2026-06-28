import type { Route } from "./+types/api.stripe-webhook";
import { getConfig } from "~/lib/config.server";
import { verifyWebhook } from "~/lib/stripe.server";
import { deletePending, getPending } from "~/lib/pending-bookings.server";
import { finalizeBooking } from "~/lib/booking-finalize.server";
import type { PaymentInfo } from "~/lib/bookings.server";

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
    if (ref && s.payment_status === "paid") {
      const pending = await getPending(ref);
      if (pending) {
        const pi = typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent as { id?: string } | undefined)?.id;
        const payment: PaymentInfo = {
          provider: "stripe",
          mode: "payment",
          accountId: pending.account,
          sessionId: String(s.id ?? ""),
          amount: (Number(s.amount_total) || 0) / 100,
          currency: String(s.currency ?? pending.record.currency).toUpperCase(),
          paymentIntentId: pi,
        };
        await finalizeBooking(pending, payment, pending.origin);
        await deletePending(ref);
      }
    }
  }
  return Response.json({ received: true });
}

// Not part of the contract; respond clearly to a stray GET.
export function loader() {
  return Response.json({ ok: false, error: "POST webhooks here" }, { status: 405 });
}
