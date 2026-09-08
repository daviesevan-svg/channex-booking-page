import type { Route } from "./+types/2c2p.notify";
import { finalizeFromC2pInvoice } from "~/lib/booking-finalize.server";
import { resolveRequestPropertyOrNull } from "~/lib/property-scope.server";

// 2C2P's server-to-server result (backendReturnUrl) — the backstop for a guest
// who paid and closed the tab before the return leg. Given per payment, so it
// carries ?ref= like the return URL.
//
// The body is a `{payload: <JWT>}` signed with the merchant's secret key. It
// is deliberately NOT what the booking is finalized against: the reference in
// the URL is used only as a lookup key and the outcome is re-read from 2C2P's
// Payment Inquiry inside finalizeFromC2pInvoice — the same path as the return
// leg, so the two cannot disagree and neither can a forged POST. Idempotent
// via claimBooking, so racing the return URL is safe.
//
// Always 2xx once the request is well-formed: 2C2P retries non-2xx
// deliveries, and a transient failure here is covered by the guest's own
// return leg or the next retry, both of which re-verify.
export async function action({ request, params }: Route.ActionArgs) {
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") || "";
  if (!ref) return Response.json({ ok: false, error: "missing ref" }, { status: 400 });
  const pid = await resolveRequestPropertyOrNull(params.channelId, request);
  if (!pid) return Response.json({ ok: false }, { status: 404 });
  try {
    const record = await finalizeFromC2pInvoice(pid, ref);
    return Response.json({ received: true, finalized: Boolean(record) });
  } catch (e) {
    console.log(`[2c2p-notify] finalize failed ref=${ref} pid=${pid}: ${e instanceof Error ? e.message : e}`);
    return Response.json({ received: true, finalized: false });
  }
}

// A GET here is a person (or 2C2P's URL check) looking — say what it is.
export async function loader() {
  return Response.json({ ok: true, endpoint: "2c2p-notify" });
}

// No default export on purpose: that makes this a resource route, so the JSON
// above goes back as-is. With a component, React Router would treat 2C2P's
// POST as a document request and answer with a rendered HTML page instead.
