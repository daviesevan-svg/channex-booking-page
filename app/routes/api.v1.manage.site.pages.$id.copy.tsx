import type { Route } from "./+types/api.v1.manage.site.pages.$id.copy";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import { validateCopyPatch, type Errors } from "~/lib/manage-site-validate";
import { pageCopyKeys } from "~/lib/pages";
import { getPageEditor, saveSiteCopy } from "~/lib/site.server";

const validationError = (errors: Errors) =>
  Response.json({ error: { type: "validation_error", message: "The payload has invalid fields.", fields: errors } }, { status: 422 });

// GET   /v1/manage/site/pages/:id/copy?lang= — the page's copy keys + what is
//       stored for that language (no fallback).
// PATCH — sparse edit of ONE language's page text: key → string (null clears,
//       falling back to the default language at render). Keys are restricted
//       to what the page owns, so text can never land where nothing renders
//       it. Structure is the sibling /sections endpoint — by design a
//       translation edit cannot reorder or delete sections.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  const editor = await getPageEditor(auth.pid, String(params.id ?? ""), lang);
  if (!editor) return apiError(404, "not_found", "No page with that id.");
  const keys = pageCopyKeys(editor.page);
  const owned = new Set(keys);
  return Response.json({
    data: { lang, copy_keys: keys, copy: Object.fromEntries(Object.entries(editor.text).filter(([k]) => owned.has(k))) },
  });
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH.");
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  const pageId = String(params.id ?? "");
  const editor = await getPageEditor(auth.pid, pageId, lang);
  if (!editor) return apiError(404, "not_found", "No page with that id.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  // Accept both the bare map (REST) and { copy: {...} } (the MCP tool wraps
  // it so the page id can travel alongside).
  const map = body && typeof body === "object" && !Array.isArray(body) && "copy" in (body as object) ? (body as { copy: unknown }).copy : body;
  const owned = new Set(pageCopyKeys(editor.page));
  const parsed = validateCopyPatch(map, owned);
  if (!parsed.ok) return validationError(parsed.errors);

  // saveSiteCopy is authoritative for the page's whole key set in that
  // language, so merge stored + patch first — that's where the sparse
  // contract lives (same pattern as property content).
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(editor.text)) if (owned.has(k)) merged[k] = v;
  for (const [k, v] of Object.entries(parsed.value)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  await saveSiteCopy(auth.pid, lang, pageId, merged);

  const after = await getPageEditor(auth.pid, pageId, lang);
  return Response.json({
    data: { lang, copy: Object.fromEntries(Object.entries(after?.text ?? {}).filter(([k]) => owned.has(k))) },
  });
}
