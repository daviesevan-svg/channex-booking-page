import type { Route } from "./+types/api.v1.manage.content.pages.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG, EDITABLE_PAGES, pageDef } from "~/lib/content";
import { getPageOverridesRaw, getPageText, savePageContent } from "~/lib/overrides.server";

// GET   /v1/manage/content/pages/:id?lang= — a booking-funnel page's editable
//       fields (with labels), the stored values for that language, and the
//       effective (fallback + default copy) view.
// PATCH — sparse per language; null clears (falls back). Field keys are the
//       page definition's — unknown keys are 422s.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const def = pageDef(String(params.id ?? ""));
  if (!def) return apiError(404, "not_found", `No editable page with that id. Valid ids: ${EDITABLE_PAGES.map((p) => p.id).join(", ")}.`);
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  const [values, effective] = await Promise.all([getPageOverridesRaw(auth.pid, def.id, lang), getPageText(auth.pid, def.id, lang)]);
  return Response.json({
    data: {
      id: def.id,
      lang,
      fields: def.fields.map((f) => ({ key: f.key, label: f.label, multiline: f.textarea ?? false })),
      values,
      effective,
    },
  });
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH.");
  const def = pageDef(String(params.id ?? ""));
  if (!def) return apiError(404, "not_found", `No editable page with that id. Valid ids: ${EDITABLE_PAGES.map((p) => p.id).join(", ")}.`);
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(422, "validation_error", "Body must be a JSON object.");
  const valid = new Set(def.fields.map((f) => f.key));
  for (const [k, v] of Object.entries(body)) {
    if (!valid.has(k)) return apiError(422, "validation_error", `Unknown field "${k}". Valid fields: ${[...valid].join(", ")}.`);
    if (v !== null && typeof v !== "string") return apiError(422, "validation_error", `\`${k}\` must be a string or null.`);
  }

  // savePageContent replaces the page's entry for that language and drops
  // empties — merge stored + patch first so the sparse contract holds.
  const merged: Record<string, string> = { ...(await getPageOverridesRaw(auth.pid, def.id, lang)) };
  for (const [k, v] of Object.entries(body)) {
    if (v === null || (typeof v === "string" && !v.trim())) delete merged[k];
    else merged[k] = (v as string).trim();
  }
  await savePageContent(auth.pid, def.id, lang, merged);

  const [values, effective] = await Promise.all([getPageOverridesRaw(auth.pid, def.id, lang), getPageText(auth.pid, def.id, lang)]);
  return Response.json({ data: { id: def.id, lang, values, effective } });
}
