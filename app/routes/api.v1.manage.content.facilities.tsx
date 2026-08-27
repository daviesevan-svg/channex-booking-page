import type { Route } from "./+types/api.v1.manage.content.facilities";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import { getFacilitiesExtra, getFacilitiesExtraRaw, saveFacilitiesExtra } from "~/lib/overrides.server";

// GET /v1/manage/content/facilities?lang= — the FREE-TEXT facility lines for
//     one language (the curated facility keys are settings —
//     PATCH /v1/manage/property).
// PUT — replace that language's whole list. Whole-list on purpose: the guest
//     fallback is also whole-list (a partially translated list reads worse
//     than the original), so line-by-line patching would misrepresent what
//     guests see. An empty array clears the language (falls back).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  const [values, effective] = await Promise.all([getFacilitiesExtraRaw(auth.pid, lang), getFacilitiesExtra(auth.pid, lang)]);
  return Response.json({ data: { lang, values, effective } });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PUT") return apiError(405, "method_not_allowed", "Use PUT with the full list for this language.");
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const list = Array.isArray(body) ? body : (body as { lines?: unknown })?.lines;
  if (!Array.isArray(list) || list.some((l) => typeof l !== "string")) {
    return apiError(422, "validation_error", "Send a JSON array of strings (or { lines: [...] }). An empty array clears this language.");
  }
  const lines = (list as string[]).map((l) => l.trim()).filter(Boolean);
  await saveFacilitiesExtra(auth.pid, lang, lines);
  const [values, effective] = await Promise.all([getFacilitiesExtraRaw(auth.pid, lang), getFacilitiesExtra(auth.pid, lang)]);
  return Response.json({ data: { lang, values, effective } });
}
