import type { Route } from "./+types/api.v1.manage.emails.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG, EMAIL_TEMPLATES, emailDef } from "~/lib/content";
import { getEmailOverridesRaw, getEmailTemplate, saveEmailContent } from "~/lib/overrides.server";

// GET   /v1/manage/emails/:id?lang= — one template: stored overrides for that
//       language + the effective text (defaults → default-lang → lang) +
//       fields and valid {tokens}.
// PATCH — sparse per language: field → text (null clears → fallback).
//       Unknown {tokens} in the text render literally rather than throwing
//       (the templates are deliberately AI-safe), so the only hard rule is
//       the field keys.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const def = emailDef(String(params.id ?? ""));
  if (!def) return apiError(404, "not_found", `No email template with that id. Valid ids: ${EMAIL_TEMPLATES.map((t) => t.id).join(", ")}.`);
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  const [values, effective] = await Promise.all([getEmailOverridesRaw(auth.pid, def.id, lang), getEmailTemplate(auth.pid, def.id, lang)]);
  return Response.json({
    data: {
      id: def.id,
      recipient: def.recipient,
      lang,
      fields: def.fields.map((f) => ({ key: f.key, label: f.label, multiline: f.textarea ?? false })),
      tokens: def.tokens.map((t) => ({ token: t.token, description: t.desc })),
      values,
      effective,
    },
  });
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH.");
  const def = emailDef(String(params.id ?? ""));
  if (!def) return apiError(404, "not_found", `No email template with that id. Valid ids: ${EMAIL_TEMPLATES.map((t) => t.id).join(", ")}.`);
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

  // saveEmailContent replaces the template's entry for that language and
  // drops empties — merge stored + patch first so sparse holds.
  const merged: Record<string, string> = { ...(await getEmailOverridesRaw(auth.pid, def.id, lang)) };
  for (const [k, v] of Object.entries(body)) {
    if (v === null || (typeof v === "string" && !v.trim())) delete merged[k];
    else merged[k] = (v as string).trim();
  }
  await saveEmailContent(auth.pid, def.id, lang, merged);

  const [values, effective] = await Promise.all([getEmailOverridesRaw(auth.pid, def.id, lang), getEmailTemplate(auth.pid, def.id, lang)]);
  return Response.json({ data: { id: def.id, lang, values, effective } });
}
