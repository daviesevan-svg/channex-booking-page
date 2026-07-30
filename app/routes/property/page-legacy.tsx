// Redirect for website pages at their old address.
//
// Custom pages used to live at `/:channelId/:pageSlug`. They moved under `/p/`
// because a single segment at the ROOT of a custom domain is ambiguous: on
// book.roompanda.com `/spilmanhotel` is a property, and on spilmanhotel.co.uk
// `/parking` is a page. React Router cannot see the hostname while matching, and
// a route that matches then throws is final — there is no fall-through — so the
// two readings had to be told apart in the URL instead of at request time.
//
// This keeps the old links working. It only redirects slugs that are REAL pages;
// an unknown one still 404s here rather than bouncing to `/p/typo` to 404 there,
// which would turn every mistyped URL into a redirect for crawlers to follow.
//
// Registered LAST under `/:channelId`, same as the route it replaces: React
// Router ranks static above dynamic, which is what keeps `/rooms` and `/checkout`
// in the funnel rather than being read as page slugs.

import { redirect } from "react-router";

import type { Route } from "./+types/page-legacy";
import { basePath } from "~/lib/base";
import { langFromRequest } from "~/lib/content";
import { getSettings } from "~/lib/overrides.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { getRenderPage } from "~/lib/site.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const settings = await getSettings(pid);
  if (!settings.websiteEnabled) throw new Response("Not found", { status: 404 });

  const page = await getRenderPage(pid, params.pageSlug, langFromRequest(request));
  if (!page) throw new Response("Not found", { status: 404 });

  // 301: the page has genuinely moved, so let crawlers and browsers cache it.
  // Carry the query string — a shared link may hold ?lang=de.
  const { search } = new URL(request.url);
  throw redirect(`${basePath(params.channelId)}/p/${params.pageSlug}${search}`, 301);
}
