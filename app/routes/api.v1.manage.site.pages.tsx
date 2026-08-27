import type { Route } from "./+types/api.v1.manage.site.pages";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import { createPage, listPages } from "~/lib/site.server";

// GET  /v1/manage/site/pages — page summaries (default-language titles).
// POST /v1/manage/site/pages — { slug, title }. The title is written in the
//      default language (it's what every other language falls back to); the
//      new page starts with a rich-text section.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const pages = await listPages(auth.pid, DEFAULT_LANG);
  return Response.json({ data: pages.map((p) => ({ id: p.id, slug: p.slug, nav: p.nav, title: p.title, section_count: p.sectionCount, is_home: p.isHome })) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "Use POST with { slug, title }.");
  let body: { slug?: unknown; title?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const slug = typeof body.slug === "string" ? body.slug : "";
  const title = typeof body.title === "string" ? body.title : "";
  const result = await createPage(auth.pid, slug, title);
  if ("error" in result) return apiError(422, "validation_error", result.error);
  return Response.json({ data: { id: result.id, slug, title } }, { status: 201 });
}
