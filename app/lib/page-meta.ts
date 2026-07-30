// Guest-page <title> and meta description.
//
// Every guest route runs under routes/property/layout, whose loader already
// resolves the guest language and the hotel name. `meta()` can't call a loader,
// but it does get `matches` — so we read the layout's data from there rather
// than making each route re-fetch or hardcode English.
//
// Before this existed the landing and results pages had NO <title> at all and
// nothing had a description, which is not survivable for a page whose whole job
// is to be found.
//
// Guest-only on purpose: every guest route imports this, so anything it imports
// ships to every hotel's public pages. The admin equivalent lives in
// admin-meta.ts — when both were here, the admin dictionary (82 kB gzipped) was
// downloaded by every visitor to every landing page.

import { DEFAULT_LANG } from "./content";
import { makeTranslator } from "./i18n";

interface LayoutData {
  lang: string;
  hotelName: string;
}

/** Structural subset of what React Router hands `meta()` — every route's
 *  generated `matches` tuple is assignable to this. */
type MetaMatch = { id: string; loaderData?: unknown } | undefined;

// The layout is mounted twice — once under `:channelId` with its file-derived id,
// once at the root with an explicit one (see guestRoutes() in routes.ts). Both
// have to be recognised here. Matching only the first meant that on a hotel's
// custom domain every title lost the hotel name AND `lang` fell back to the
// default, so meta descriptions came out in English whatever the guest picked.
const LAYOUT_IDS = ["routes/property/layout", "host"];

function chrome(matches: readonly MetaMatch[]): { lang: string; hotelName: string } {
  const data = matches.find((m) => m && LAYOUT_IDS.includes(m.id))?.loaderData as
    | Partial<LayoutData>
    | undefined;
  return { lang: data?.lang ?? DEFAULT_LANG, hotelName: data?.hotelName ?? "" };
}

export interface PageMetaOptions {
  /** i18n key for the title template. May use {hotel} and anything in `vars`. */
  titleKey: string;
  /** i18n key for the description. Omit on pages that shouldn't be indexed. */
  descKey?: string;
  /** Literal description, used ahead of `descKey` (e.g. a room's own copy). */
  descText?: string;
  /** Extra interpolation values, e.g. { room: "Garden Suite" }. */
  vars?: Record<string, string | number>;
  /** Keep out of search results — anything behind a booking reference or code. */
  noindex?: boolean;
}

/** Build the meta descriptors for a guest page, in the guest's language. */
export function pageMeta(
  matches: readonly MetaMatch[],
  { titleKey, descKey, descText, vars, noindex }: PageMetaOptions,
): Array<Record<string, string>> {
  const { lang, hotelName } = chrome(matches);
  const tr = makeTranslator(lang);
  const all = { hotel: hotelName, ...vars };

  const out: Array<Record<string, string>> = [{ title: tr.t(titleKey, all) }];
  const description = descText?.trim() || (descKey ? tr.t(descKey, all) : "");
  if (description) out.push({ name: "description", content: truncate(description) });
  if (noindex) out.push({ name: "robots", content: "noindex" });
  return out;
}

/** Trim to a length search engines will actually show, on a word boundary. */
export function truncate(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:!?-]+$/, "")}…`;
}
