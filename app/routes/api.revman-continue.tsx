// Internal continuation endpoint for chunked revenue-management imports.
// Each invocation processes one chunk within fresh Worker limits and kicks the
// next — background work started from a single request is time-capped in
// production, so large imports must hop across invocations. Callers are the
// Worker itself (signed self-fetch) only; the signature is an HMAC of the pid
// with the session secret, so the endpoint can't be used to poke arbitrary
// properties from outside.
import type { Route } from "./+types/api.revman-continue";
import { getConfig } from "~/lib/config.server";
import { hmacSha256Hex, timingSafeEqual } from "~/lib/hmac.server";
import { continueRevmanImport } from "~/lib/revman.server";

export async function action({ request }: Route.ActionArgs) {
  const body = (await request.json().catch(() => null)) as { pid?: unknown; sig?: unknown } | null;
  const pid = typeof body?.pid === "string" ? body.pid : "";
  const sig = typeof body?.sig === "string" ? body.sig : "";
  if (!pid || !sig) return new Response("bad request", { status: 400 });
  const expected = await hmacSha256Hex(getConfig().sessionSecret, `revman-continue:${pid}`);
  if (!timingSafeEqual(sig, expected)) return new Response("forbidden", { status: 403 });
  await continueRevmanImport(pid);
  return new Response(null, { status: 204 });
}
