import type { Route } from "./+types/api.viva-webhook";
import { getVivaConfig } from "~/lib/overrides.server";
import { extractOrderCode, retrieveVivaWebhookKey, VIVA_EVENT_PAYMENT_CREATED } from "~/lib/viva.server";
import { finalizeFromVivaOrder } from "~/lib/booking-finalize.server";

// /api/viva-webhook/:propertyId — per-property because Viva webhooks are
// per-merchant. The :propertyId is the internal id (a UUID, effectively
// unguessable), shown to the operator on /admin/payments to paste into their
// Viva banking app (Settings → API Access → Webhooks).

// GET — Viva's endpoint verification: when the operator saves the URL, Viva
// GETs it and expects the merchant's webhook key echoed back as {"Key": "..."}.
// Public by Viva's design (their docs say to check it in a browser); the key
// only proves to Viva that we can call their API with this merchant's own
// credentials.
export async function loader({ params }: Route.LoaderArgs) {
  const viva = await getVivaConfig(params.propertyId ?? "");
  if (!viva) return Response.json({ ok: false, error: "Viva is not connected for this property." }, { status: 404 });
  try {
    const key = await retrieveVivaWebhookKey(viva);
    return Response.json({ Key: key });
  } catch (e) {
    console.log(`[viva-webhook] key fetch failed pid=${params.propertyId}: ${e instanceof Error ? e.message : e}`);
    return Response.json({ ok: false, error: "Could not fetch the webhook key from Viva." }, { status: 502 });
  }
}

interface VivaEvent {
  EventTypeId?: number;
  EventData?: { TransactionId?: string; OrderCode?: unknown };
}

// POST — payment notifications. Viva webhooks carry no signature; authenticity
// comes from re-fetching the transaction from Viva's API with the property's
// own credentials inside finalizeFromVivaOrder (which is also idempotent, so
// racing the return URL is safe). The backstop for a guest who paid and closed
// the tab. Always 2xx, or Viva keeps retrying.
export async function action({ params, request }: Route.ActionArgs) {
  const viva = await getVivaConfig(params.propertyId ?? "");
  if (!viva) return Response.json({ ok: false }, { status: 404 });

  const raw = await request.text();
  let event: VivaEvent;
  try {
    event = JSON.parse(raw) as VivaEvent;
  } catch {
    return Response.json({ ok: false, error: "malformed body" }, { status: 400 });
  }

  if (event.EventTypeId === VIVA_EVENT_PAYMENT_CREATED) {
    // OrderCode arrives as a 16-digit JSON number — take it from the raw text
    // so a value above MAX_SAFE_INTEGER can't round to a code that matches
    // nothing (see viva.server.ts).
    const orderCode = extractOrderCode(raw);
    const transactionId = event.EventData?.TransactionId;
    if (orderCode && transactionId) {
      try {
        await finalizeFromVivaOrder(orderCode, transactionId);
      } catch (e) {
        // Log and still 200: finalize verifies against Viva's API, so a transient
        // error here is retried by Viva's next delivery or covered by the return URL.
        console.log(`[viva-webhook] finalize failed order=${orderCode}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return Response.json({ received: true });
}
