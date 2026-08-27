import type { Route } from "./+types/api.v1.manage.google";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { ALL_SYNC_KINDS, queueGoogleAriBlock, queueGoogleAriResync } from "~/lib/google-ari/push.server";
import { getSettings, saveGoogleAriSettings } from "~/lib/overrides.server";

const view = (s: Awaited<ReturnType<typeof getSettings>>) => ({
  push: s.googleAriPush ?? false,
  window_days: s.googleAriWindowDays ?? null,
  program: s.googleProgram ?? "hotels",
  single_unit: s.singleUnit ?? false,
});

// GET   /v1/manage/google — the direct Google Hotels ARI push settings.
// PATCH — { push?, window_days?, program? }. The state TRANSITION carries the
//       side effect, computed from the pre-write value exactly like the admin
//       page (re-reading the flag after the write once hit stale KV and
//       silently no-op'd): OFF→ON queues a full resync, ON→OFF queues a block
//       (zero inventory + stop-sell) so Google stops selling immediately.
//       "vacation_rentals" is only honored on a single-unit property.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  return Response.json({ data: view(await getSettings(auth.pid)) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH.");
  let body: { push?: unknown; window_days?: unknown; program?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  if (body.push !== undefined && typeof body.push !== "boolean") return apiError(422, "validation_error", "`push` must be a boolean.");
  if (body.window_days !== undefined && body.window_days !== null && (typeof body.window_days !== "number" || !Number.isInteger(body.window_days) || body.window_days < 1 || body.window_days > 500)) {
    return apiError(422, "validation_error", "`window_days` must be an integer 1–500, or null for the default.");
  }
  if (body.program !== undefined && body.program !== "hotels" && body.program !== "vacation_rentals") {
    return apiError(422, "validation_error", "`program` must be hotels or vacation_rentals.");
  }
  const existing = await getSettings(auth.pid);
  if (body.program === "vacation_rentals" && !existing.singleUnit) {
    return apiError(422, "validation_error", "vacation_rentals is only valid for a single-unit property (see PATCH /v1/manage/property `single_unit`).");
  }

  const wasOn = existing.googleAriPush === true;
  const push = typeof body.push === "boolean" ? body.push : wasOn;
  const settings = await saveGoogleAriSettings(auth.pid, {
    push,
    windowDays: body.window_days === null ? undefined : ((body.window_days as number | undefined) ?? existing.googleAriWindowDays),
    program: (body.program as "hotels" | "vacation_rentals" | undefined) ?? existing.googleProgram,
  });
  if (wasOn && !push) queueGoogleAriBlock(auth.pid);
  else if (!wasOn && push) queueGoogleAriResync(auth.pid, ALL_SYNC_KINDS);

  return Response.json({ data: view(settings) });
}
