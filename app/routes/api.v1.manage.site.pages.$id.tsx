import type { Route } from "./+types/api.v1.manage.site.pages.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { pageCopyKeys } from "~/lib/pages";
import { deletePage, getPageEditor, updatePage } from "~/lib/site.server";

// GET   /v1/manage/site/pages/:id?lang= — structure + THAT language's stored
//       text (no fallback — an untranslated field is visibly absent) + the
//       page's valid copy keys, which is what an agent needs before writing.
// PATCH /v1/manage/site/pages/:id — { slug?, nav? }. Home has neither.
// DELETE — removes the page, its copy in every language, and GCs its images.
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
    data: {
      id: editor.page.id,
      slug: editor.page.slug,
      nav: editor.page.nav ?? true,
      is_home: editor.isHome,
      sections: editor.page.sections,
      lang,
      copy_keys: keys,
      copy: Object.fromEntries(Object.entries(editor.text).filter(([k]) => owned.has(k))),
    },
  });
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const pageId = String(params.id ?? "");

  if (request.method === "DELETE") {
    const orphans = await deletePage(auth.pid, pageId);
    queueImageCleanup(auth.pid, orphans);
    return Response.json({ deleted: true });
  }

  if (request.method === "PATCH") {
    let body: { slug?: unknown; nav?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return apiError(400, "bad_request", "Body must be JSON.");
    }
    if (body.nav !== undefined && typeof body.nav !== "boolean") return apiError(422, "validation_error", "`nav` must be a boolean.");
    if (body.slug !== undefined && typeof body.slug !== "string") return apiError(422, "validation_error", "`slug` must be a string.");
    const result = await updatePage(auth.pid, pageId, {
      slug: body.slug as string | undefined,
      nav: body.nav as boolean | undefined,
    });
    if ("error" in result) return apiError(422, "validation_error", result.error);
    return Response.json({ updated: true });
  }

  return apiError(405, "method_not_allowed", "Use PATCH to edit or DELETE to remove.");
}
