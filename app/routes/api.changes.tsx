import type { Route } from "./+types/api.changes";
import { applyChanges, checkApiKey } from "~/lib/ari/ingest.server";
import { fireAndForget, isTransientD1Error } from "~/lib/d1.server";
import { isChannexConnected } from "~/lib/overrides.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { requestFullSyncOnce } from "~/lib/open-channel.server";

// POST /api/changes — Channex pushes availability/rate/restriction changes.
export async function action({ request }: Route.ActionArgs) {
  const unauthorized = checkApiKey(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  // Only accept changes for properties that have selected Channex. Reject the
  // whole batch if any targeted property hasn't — we don't partially apply.
  const notifications = (body as { data?: unknown })?.data;
  const hotelCodes = new Set(
    (Array.isArray(notifications) ? notifications : [])
      .map((n) => String((n as { attributes?: { hotel_code?: unknown } })?.attributes?.hotel_code ?? ""))
      .filter(Boolean),
  );
  for (const code of hotelCodes) {
    if (!(await isChannexConnected(code))) {
      return Response.json(
        { success: false, error: `Property ${code} is not connected to a channel manager.` },
        { status: 403 },
      );
    }
  }

  try {
    const counts = await applyChanges(body);
    // Forward the fresh ARI on to Google (rates/availability/inventory) for any
    // ARI-enabled property in this batch; a no-op when the property isn't
    // pushing to Google.
    //
    // Deliberately OUTSIDE the try that decides what we tell Channex, and not
    // awaited: this used to run inside it, so a KV hiccup reading the Google
    // settings reported the whole push as failed to Channex — for ARI that was
    // already committed to D1. What Channex hears must describe our own store
    // and nothing downstream of it.
    for (const code of hotelCodes) {
      fireAndForget(
        queueGoogleAriPush(code, ["ari"]).catch((e) =>
          console.log(`[ari] google forward failed for ${code}: ${e instanceof Error ? e.message : e}`),
        ),
      );
    }
    return Response.json({ success: true, ...counts });
  } catch (e) {
    // Whatever the cause, our stored ARI may now disagree with Channex, and
    // Channex does not re-send a delivered change: ask for the property in full
    // instead of leaving the gap to be discovered by an overbooking. Rate
    // limited per property, and after the response so it can't add latency to
    // a request that is already failing.
    for (const code of hotelCodes) {
      fireAndForget(
        requestFullSyncOnce(code).then((r) =>
          console.log(
            r.ok
              ? `[ari] full sync requested for ${code}${r.skipped ? " (skipped, recent)" : ""}`
              : `[ari] full sync request failed for ${code}: ${r.error}`,
          ),
        ).catch((err) => console.log(`[ari] full sync request threw for ${code}: ${err instanceof Error ? err.message : err}`)),
      );
    }
    // A transient D1 failure is not a rejected payload. 422 says "unprocessable
    // entity" — permanent, don't bother re-sending — which is how a single
    // recycled D1 instance became a lost stop-sell. 503 says what is true: our
    // storage was unavailable, the message is fine, try again.
    const transient = isTransientD1Error(e);
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : "Failed to apply changes" },
      { status: transient ? 503 : 422 },
    );
  }
}

// A GET here isn't part of the contract; respond clearly rather than 404.
export async function loader() {
  return Response.json({ success: false, error: "POST changes here" }, { status: 405 });
}
