import type { Route } from "./+types/api.v1.manage.site";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { getSettings } from "~/lib/overrides.server";
import { isSiteStyleId, SITE_STYLE_IDS } from "~/lib/site-style";
import { getSiteStyle, listPages, saveSiteStyle } from "~/lib/site.server";
import { DEFAULT_LANG } from "~/lib/content";

// GET   /v1/manage/site — website state: enabled flag (read-only — turning the
//       website on/off stays in the admin UI for now), layout style, pages.
// PATCH /v1/manage/site — { style } only. Content-safe by construction:
//       saveSiteStyle writes one field and touches neither pages nor copy.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const [settings, style, pages] = await Promise.all([getSettings(auth.pid), getSiteStyle(auth.pid), listPages(auth.pid, DEFAULT_LANG)]);
  return Response.json({
    data: {
      website_enabled: settings.websiteEnabled ?? false,
      style: style ?? "classic",
      styles: SITE_STYLE_IDS,
      pages: pages.map((p) => ({ id: p.id, slug: p.slug, nav: p.nav, title: p.title, section_count: p.sectionCount, is_home: p.isHome })),
    },
  });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH with { style }.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const style = (body as { style?: unknown })?.style;
  if (typeof style !== "string" || !isSiteStyleId(style)) {
    return apiError(422, "validation_error", `style must be one of: ${SITE_STYLE_IDS.join(", ")}.`);
  }
  await saveSiteStyle(auth.pid, style);
  return Response.json({ data: { style } });
}
