// Internal continuation endpoint for chunked competitor-price capture. Each
// invocation processes one small chunk within fresh Worker limits and kicks the
// next — background work from a single request is time-capped in production, so
// a multi-day/multi-hotel capture must hop across invocations. Caller is the
// Worker itself (signed self-fetch); the signature is an HMAC of the pid with
// the session secret, so it can't be poked from outside.
import type { Route } from "./+types/api.revman-capture-continue";
import { getConfig } from "~/lib/config.server";
import { hmacSha256Hex, timingSafeEqual } from "~/lib/hmac.server";
import { continueCaptureJob } from "~/lib/revman-comp-capture.server";

export async function action({ request }: Route.ActionArgs) {
  const body = (await request.json().catch(() => null)) as { pid?: unknown; sig?: unknown } | null;
  const pid = typeof body?.pid === "string" ? body.pid : "";
  const sig = typeof body?.sig === "string" ? body.sig : "";
  if (!pid || !sig) return new Response("bad request", { status: 400 });
  const expected = await hmacSha256Hex(getConfig().sessionSecret, `revcap-continue:${pid}`);
  if (!timingSafeEqual(sig, expected)) return new Response("forbidden", { status: 403 });
  await continueCaptureJob(pid);
  return new Response(null, { status: 204 });
}
