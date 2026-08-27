import type { Route } from "./+types/api.v1.manage.gallery.text";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import type { GalleryText } from "~/lib/gallery";
import { getGallery, saveGalleryLang } from "~/lib/gallery.server";

// PATCH /v1/manage/gallery/text?lang= — sparse alt/caption edits for ONE
// language: imageId → { alt?, caption? } (null field clears it; null entry
// clears both). Unknown image ids are 422s.
export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH.");
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const map = body && typeof body === "object" && !Array.isArray(body) && "text" in (body as object) ? (body as { text: unknown }).text : body;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return apiError(422, "validation_error", "Send an object of imageId → { alt?, caption? } (null clears).");
  }

  const gallery = await getGallery(auth.pid);
  const known = new Set(gallery.images.map((i) => i.id));
  const merged: Record<string, GalleryText> = { ...(gallery.text[lang] ?? {}) };
  for (const [id, t] of Object.entries(map as Record<string, unknown>)) {
    if (!known.has(id)) return apiError(422, "validation_error", `"${id}" is not a gallery image id — GET /v1/manage/gallery for the list.`);
    if (t === null) {
      delete merged[id];
      continue;
    }
    if (typeof t !== "object" || Array.isArray(t)) return apiError(422, "validation_error", `"${id}" must be { alt?, caption? } or null.`);
    const entry = t as { alt?: unknown; caption?: unknown };
    const current = merged[id] ?? {};
    const next: GalleryText = { ...current };
    if (entry.alt !== undefined) {
      if (entry.alt !== null && typeof entry.alt !== "string") return apiError(422, "validation_error", `"${id}".alt must be a string or null.`);
      if (entry.alt === null) delete next.alt;
      else next.alt = entry.alt;
    }
    if (entry.caption !== undefined) {
      if (entry.caption !== null && typeof entry.caption !== "string") return apiError(422, "validation_error", `"${id}".caption must be a string or null.`);
      if (entry.caption === null) delete next.caption;
      else next.caption = entry.caption;
    }
    merged[id] = next;
  }
  await saveGalleryLang(auth.pid, lang, gallery.images.map((i) => i.id), merged);

  const after = await getGallery(auth.pid);
  return Response.json({ data: { lang, text: after.text[lang] ?? {} } });
}
