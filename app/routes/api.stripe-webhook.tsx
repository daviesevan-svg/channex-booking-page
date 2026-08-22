import type { Route } from "./+types/api.stripe-webhook";
import { getConfig } from "~/lib/config.server";
import { verifyWebhook } from "~/lib/stripe.server";
import { finalizeFromStripeSession } from "~/lib/booking-finalize.server";
import { finalizeVoucherFromStripeSession } from "~/lib/voucher-purchase.server";
import { SessionBindError, refsFromStripeCheckoutEvent } from "~/lib/stripe-session-bind";

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

  const completed = refsFromStripeCheckoutEvent(event);
  if (completed) {
    // Re-fetch the session on the connected account for authoritative status +
    // card details, then bind it to the pending (client_reference_id + pid).
    // Idempotent finalize handles a race with the return URL. A swapped
    // session is SessionBindError — fail closed, ack the event (no retry).
    try {
      if (completed.kind === "voucher") await finalizeVoucherFromStripeSession(completed.ref, completed.sessionId);
      else await finalizeFromStripeSession(completed.ref, completed.sessionId);
    } catch (e) {
      if (e instanceof SessionBindError) {
        console.error(`[stripe-webhook] reject ${completed.ref}: ${e.message}`);
      } else {
        throw e;
      }
    }
  }
  return Response.json({ received: true });
}

// Not part of the contract; respond clearly to a stray GET.
export function loader() {
  return Response.json({ ok: false, error: "POST webhooks here" }, { status: 405 });
}
