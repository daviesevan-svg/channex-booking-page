// An extra website page — "about", "dining", "spa".
//
// A catch-all for one segment under `/:channelId`, so it must be the LAST child:
// React Router ranks static above dynamic, which is what keeps `/rooms` and
// `/checkout` hitting the funnel rather than being read as page slugs. Page slugs
// are validated against those names on save, so a hotel can't create a page here
// that it could never open.
//
// An unknown slug 404s, and so does every slug when the website layer is off —
// there's no website for the page to belong to.

import type { Route } from "./+types/page";
import { pageMeta } from "~/lib/page-meta";
import { SectionList } from "~/components/section-list";
import { langFromRequest } from "~/lib/content";
import { useT } from "~/lib/i18n";
import { useProperty } from "~/lib/booking-context";
import { getSettings } from "~/lib/overrides.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { loadSectionData } from "~/lib/section-data.server";
import { getRenderPage } from "~/lib/site.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const lang = langFromRequest(request);
  const pid = await resolvePropertyId(params.channelId);
  const settings = await getSettings(pid);
  if (!settings.websiteEnabled) throw new Response("Not found", { status: 404 });

  const page = await getRenderPage(pid, params.pageSlug, lang);
  if (!page) throw new Response("Not found", { status: 404 });

  const data = await loadSectionData(pid, lang, page.sections, settings);
  return { page, data };
}

export function meta({ matches, loaderData }: Route.MetaArgs) {
  return pageMeta(matches, {
    // The page's own name, not a translated label — the hotel wrote it.
    titleKey: "metaPage",
    vars: { page: loaderData?.page?.title ?? "" },
    descText: loaderData?.page?.metaDescription,
  });
}

export default function WebsitePage({ loaderData, params }: Route.ComponentProps) {
  const { page, data } = loaderData;
  const { hotelName } = useProperty();
  const tr = useT();

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-16">
      {page.title && (
        <h1 className="max-w-[720px] font-serif text-display-3xl font-medium leading-[1.1] tracking-[-0.02em]">
          {page.title}
        </h1>
      )}
      {/* Sections carry their own top margin, so the heading needs none. */}
      <SectionList
        sections={page.sections}
        data={data}
        tr={tr}
        hotelName={hotelName}
      />
    </main>
  );
}
