import type { Route } from "./+types/api.v1.manage.site.pages.$id.sections";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { validateSections, type Errors } from "~/lib/manage-site-validate";
import { sectionIdFor } from "~/lib/pages";
import type { SiteSection } from "~/lib/sections";
import { getPageEditor, savePageSections } from "~/lib/site.server";

const validationError = (errors: Errors) =>
  Response.json({ error: { type: "validation_error", message: "The payload has invalid fields.", fields: errors } }, { status: 422 });

// PUT /v1/manage/site/pages/:id/sections — replace one page's STRUCTURE.
// Text is deliberately untouched (reordering or hiding a section must never
// drop what's written in it) — copy lives on the sibling /copy endpoint.
// Keep section ids stable across saves: they key the per-language copy, so a
// PUT that regenerates ids orphans every translation. Images dropped by the
// replace are garbage-collected.
export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PUT") return apiError(405, "method_not_allowed", "Use PUT with the full section array.");
  const pageId = String(params.id ?? "");
  const editor = await getPageEditor(auth.pid, pageId, DEFAULT_LANG);
  if (!editor) return apiError(404, "not_found", "No page with that id.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  // Accept both the bare array (REST) and { sections: [...] } (the MCP tool
  // wraps it so the page id can travel alongside).
  const list = Array.isArray(body) ? body : (body as { sections?: unknown })?.sections;
  const parsed = validateSections(list, { isHome: editor.isHome });
  if (!parsed.ok) return validationError(parsed.errors);

  // Assign ids to new sections the same way the editor does (type as the id
  // for the first of its kind, uuid after), avoiding both existing ids and the
  // ones this payload carries.
  const taken = new Set<string>(parsed.value.map((s) => s.id).filter((v): v is string => Boolean(v)));
  const sections: SiteSection[] = parsed.value.map((s) => {
    let id = s.id;
    if (!id) {
      id = sectionIdFor(s.type, pageId, taken);
      taken.add(id);
    }
    return { ...s, id };
  });

  const orphans = await savePageSections(auth.pid, pageId, sections);
  queueImageCleanup(auth.pid, orphans);
  const after = await getPageEditor(auth.pid, pageId, DEFAULT_LANG);
  return Response.json({ data: { sections: after?.page.sections ?? [] } });
}
