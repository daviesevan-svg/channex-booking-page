import type { Route } from "./+types/api.changes";
import { applyChanges, checkApiKey } from "~/lib/ari/ingest.server";
import { fireAndForget, isTransientD1Error } from "~/lib/d1.server";
import { isChannexConnected } from "~/lib/overrides.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { clearGoogleAriRepair } from "~/lib/google-ari/repair.server";
import { ariScopesFromChanges } from "~/lib/google-ari/scope";
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
    const repairRevision = crypto.randomUUID();
    const counts = await applyChanges(body, { repairRevision });
    // Forward the fresh ARI on to Google (rates/availability/inventory) for any
    // ARI-enabled property in this batch; a no-op when the property isn't
    // pushing to Google.
    //
    // Delivery has its own error handler. A downstream KV or queue failure
    // must not tell Channex that committed inventory failed; the repair marker
    // keeps admission retryable after this response.
    for (const [code, scope] of ariScopesFromChanges(body)) {
      fireAndForget(
        queueGoogleAriPush(code, ["ari"], scope)
          // Admission failed: leave the marker for the minute cron.
          .then((queued) => (queued ? clearGoogleAriRepair(code, repairRevision) : undefined))
          .catch((e) =>
            console.log(`[ari] google forward retained for scheduled repair for ${code}: ${e instanceof Error ? e.message : e}`),
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
