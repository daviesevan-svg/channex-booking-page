// Internal continuation endpoint for chunked VR availability capture — mirrors
// api.revman-capture-continue. Signed self-fetch from the Worker (HMAC of the
// pid with the session secret); can't be poked from outside.
import type { Route } from "./+types/api.vr-capture-continue";
import { getConfig } from "~/lib/config.server";
import { hmacSha256Hex, timingSafeEqual } from "~/lib/hmac.server";
import { continueVrCaptureJob } from "~/lib/vr-comp-capture.server";

export async function action({ request }: Route.ActionArgs) {
  const body = (await request.json().catch(() => null)) as { pid?: unknown; sig?: unknown } | null;
  const pid = typeof body?.pid === "string" ? body.pid : "";
  const sig = typeof body?.sig === "string" ? body.sig : "";
  if (!pid || !sig) return new Response("bad request", { status: 400 });
  const expected = await hmacSha256Hex(getConfig().sessionSecret, `vrcap-continue:${pid}`);
  if (!timingSafeEqual(sig, expected)) return new Response("forbidden", { status: 403 });
  await continueVrCaptureJob(pid);
  return new Response(null, { status: 204 });
}
