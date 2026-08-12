// Website page storage — one KV key per property (`site:{pid}`).
//
// Structure (which pages exist, which sections, in what order, with what
// settings) is stored once and is language-independent. Text lives in a
// per-language map keyed `${owner}.${field}`, where the owner is a section id or
// `page_{pageId}`. That split is the whole point: editing German can never
// reorder or delete a section, and each field falls back to the default
// language, so a half-translated page renders complete rather than blank.

import { getConfigKV } from "./config.server";
import { DEFAULT_LANG } from "./content";
import {
  FOOTER_COPY_ID,
  footerBlurbKey,
  footerLinkKey,
  normalizeFooter,
  SOCIAL_LABEL,
  type ResolvedFooter,
  type SiteFooter,
} from "./footer";
import {
  HOME_PAGE_ID,
  MAX_PAGES,
  newPageId,
  normalizePageSlug,
  pageCopyKeys,
  pageSlugError,
  pageTextKey,
  sectionIdFor,
  type PageTextField,
} from "./pages";
import {
  DEFAULT_PAGE_SECTIONS,
  DEFAULT_WEBSITE_SECTIONS,
  imageAltKey,
  LEGACY_SECTIONS,
  MAX_SECTION_IMAGES,
  normalizeSections,
  SECTION_DEFS,
  type ResolvedSection,
  type SiteConfig,
  type SitePage,
  type SiteSection,
} from "./sections";
import type { SiteStyleId } from "./site-style";

const key = (pid: string) => `site:${pid}`;
const HOME_SLUG = "";

export type { ResolvedSection };

const empty = (): SiteConfig => ({ pages: [], copy: {} });

async function read(pid: string): Promise<SiteConfig> {
  const kv = getConfigKV();
  if (!kv) return empty();
  const raw = await kv.get(key(pid));
  if (!raw) return empty();
  try {
    const parsed = JSON.parse(raw) as Partial<SiteConfig>;
    return {
      pages: parsed.pages ?? [],
      copy: parsed.copy ?? {},
      footer: parsed.footer,
      footerCopy: parsed.footerCopy ?? {},
      // Not validated here: `siteStyle()` resolves an unknown id to the default
      // at render time, so a value from a newer deploy or a hand edit degrades to
      // classic instead of being silently rewritten on the next save.
      style: parsed.style,
    };
  } catch {
    return empty();
  }
}

async function write(pid: string, config: SiteConfig): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(key(pid), JSON.stringify(config));
}

const isHome = (p: { slug: string }) => p.slug === HOME_SLUG;

/**
 * Every page, cleaned up: home always first and always present, ids filled in,
 * sections normalized for the page they're on.
 *
 * Pages stored before ids existed carry only a slug, so the home page's id is
 * derived rather than read — that's what keeps copy written under the old
 * `${sectionId}.${field}` keys resolving.
 */
function pagesOf(config: SiteConfig): SitePage[] {
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  const out: SitePage[] = [];
  for (const p of config.pages) {
    if (!p || typeof p.slug !== "string") continue;
    const slug = isHome(p) ? HOME_SLUG : normalizePageSlug(p.slug);
    if (!isHome(p) && !slug) continue;
    if (seenSlugs.has(slug)) continue;
    const id = isHome(p) ? HOME_PAGE_ID : p.id || newPageId(seenIds);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    seenSlugs.add(slug);
    out.push({
      id,
      slug,
      nav: p.nav === true,
      sections: normalizeSections(p.sections ?? [], isHome(p)),
    });
  }
  if (!out.some(isHome)) {
    // No stored home page means the hotel hasn't customised it — show the
    // default layout, which is what the guest page renders too.
    out.unshift({
      id: HOME_PAGE_ID,
      slug: HOME_SLUG,
      nav: false,
      sections: normalizeSections(DEFAULT_WEBSITE_SECTIONS),
    });
  }
  return out.sort((a, b) => (isHome(a) ? -1 : isHome(b) ? 1 : 0));
}

/** Text resolved for one language, per field, falling back to the default
 *  language — a translated heading with an untranslated body still shows both. */
function resolveText(
  config: SiteConfig,
  lang: string,
  sections: SiteSection[],
): ResolvedSection[] {
  const base = config.copy[DEFAULT_LANG] ?? {};
  const loc = config.copy[lang] ?? {};
  return sections.map((s) => {
    const text: Record<string, string> = {};
    const pick = (field: string) => {
      const v = loc[`${s.id}.${field}`] || base[`${s.id}.${field}`];
      if (v) text[field] = v;
    };
    for (const f of SECTION_DEFS[s.type].fields) {
      if (f.localized) pick(f.key);
    }
    // One alt text per image, under the same `${owner}.${field}` keys as the
    // rest, so the renderer reads it out of the same `text` map.
    for (const img of s.images ?? []) pick(imageAltKey(img.id));
    return { ...s, text };
  });
}

function pageText(
  config: SiteConfig,
  lang: string,
  pageId: string,
  field: PageTextField,
): string {
  const k = pageTextKey(pageId, field);
  return (config.copy[lang]?.[k] || config.copy[DEFAULT_LANG]?.[k] || "").trim();
}

// ---------------------------------------------------------------- home page

/**
 * The sections to render on the home page, with text resolved for `lang`.
 *
 * `websiteEnabled` off returns the booking page's long-standing section order,
 * so that page is exactly what it always was — one renderer, no second code
 * path to drift.
 */
export async function getRenderSections(
  pid: string,
  lang: string,
  websiteEnabled: boolean,
): Promise<ResolvedSection[]> {
  if (!websiteEnabled) return legacySections();
  const config = await read(pid);
  const home = pagesOf(config).find(isHome)!;
  return resolveText(config, lang, home.sections.filter((s) => !s.hidden));
}

function legacySections(): ResolvedSection[] {
  // Legacy layout takes no custom copy: it renders the same translated
  // defaults it always has. The hero's layout is pinned to "wide" here, not
  // left to the field default — the booking page has always been a single
  // full-width column and a default change must not reach it.
  return LEGACY_SECTIONS.map((s) => ({
    ...s,
    settings: (s.type === "hero" ? { layout: "wide" } : {}) as SiteSection["settings"],
    text: {},
  }));
}

// ---------------------------------------------------------------- extra pages

/** A page ready to render, with its own text and its sections' text resolved. */
export interface RenderPage {
  id: string;
  slug: string;
  title: string;
  metaDescription: string;
  sections: ResolvedSection[];
}

/**
 * One extra page by slug, or null when there's no such page. The caller 404s on
 * null — this is reached by a catch-all route, so "no page" is the common case
 * for a typo'd URL rather than an error.
 */
export async function getRenderPage(
  pid: string,
  slug: string,
  lang: string,
): Promise<RenderPage | null> {
  const wanted = normalizePageSlug(slug);
  if (!wanted) return null;
  const config = await read(pid);
  const page = pagesOf(config).find((p) => p.slug === wanted);
  if (!page) return null;
  return {
    id: page.id,
    slug: page.slug,
    title: pageText(config, lang, page.id, "title"),
    metaDescription: pageText(config, lang, page.id, "metaDescription"),
    sections: resolveText(config, lang, page.sections.filter((s) => !s.hidden)),
  };
}

/** The page list for the admin index: structure plus the title in `lang`. */
export interface PageSummary {
  id: string;
  slug: string;
  nav: boolean;
  title: string;
  sectionCount: number;
  isHome: boolean;
}

export async function listPages(pid: string, lang: string): Promise<PageSummary[]> {
  const config = await read(pid);
  return pagesOf(config).map((p) => ({
    id: p.id,
    slug: p.slug,
    nav: p.nav === true,
    title: pageText(config, lang, p.id, "title"),
    sectionCount: p.sections.filter((s) => !s.hidden).length,
    isHome: isHome(p),
  }));
}

/** Everything the section editor needs for one page in one language. Returns
 *  null for an unknown id, so a stale bookmark 404s rather than editing home. */
export async function getPageEditor(
  pid: string,
  pageId: string,
  lang: string,
): Promise<{
  page: SitePage;
  isHome: boolean;
  text: Record<string, string>;
  /** The default language's text, shown as a placeholder — no fallback here:
   *  the editor must show what IS set in this language. */
  baseText: Record<string, string>;
} | null> {
  const config = await read(pid);
  const page = pagesOf(config).find((p) => p.id === pageId);
  if (!page) return null;
  return {
    page,
    isHome: isHome(page),
    text: config.copy[lang] ?? {},
    baseText: lang === DEFAULT_LANG ? {} : (config.copy[DEFAULT_LANG] ?? {}),
  };
}

/** Add a page. Returns an error string the form can show, or the new id. */
export async function createPage(
  pid: string,
  rawSlug: string,
  title: string,
): Promise<{ error: string } | { id: string }> {
  const config = await read(pid);
  const pages = pagesOf(config);
  if (pages.filter((p) => !isHome(p)).length >= MAX_PAGES) {
    return { error: `You can have up to ${MAX_PAGES} extra pages.` };
  }
  const slug = normalizePageSlug(rawSlug);
  const id = newPageId(pages.map((p) => p.id));
  const err = pageSlugError(slug, id, pages);
  if (err) return { error: err };
  const clean = title.trim();
  if (!clean) return { error: "Give the page a title." };

  const sections: SiteSection[] = DEFAULT_PAGE_SECTIONS.map((type) => ({
    id: sectionIdFor(type, id, []),
    type,
    hidden: false,
    settings: {},
  }));
  // The title is written in the DEFAULT language: it's the fallback every other
  // language resolves through, so a page created while editing German still has
  // a name in English.
  const copy = { ...config.copy };
  copy[DEFAULT_LANG] = { ...(copy[DEFAULT_LANG] ?? {}), [pageTextKey(id, "title")]: clean };

  await write(pid, {
    ...config,
    pages: [...pages, { id, slug, nav: true, sections }],
    copy,
  });
  return { id };
}

/** Change a page's address or whether it's in the menu. Home has neither. */
export async function updatePage(
  pid: string,
  pageId: string,
  patch: { slug?: string; nav?: boolean },
): Promise<{ error: string } | { ok: true }> {
  const config = await read(pid);
  const pages = pagesOf(config);
  const page = pages.find((p) => p.id === pageId);
  if (!page || isHome(page)) return { error: "That page no longer exists." };

  let slug = page.slug;
  if (patch.slug !== undefined) {
    slug = normalizePageSlug(patch.slug);
    const err = pageSlugError(slug, pageId, pages);
    if (err) return { error: err };
  }
  await write(pid, {
    ...config,
    pages: pages.map((p) =>
      p.id === pageId ? { ...p, slug, nav: patch.nav ?? p.nav } : p,
    ),
  });
  return { ok: true };
}

/** The picture urls a set of sections points at. */
const imageUrlsOf = (sections: SiteSection[]): string[] =>
  sections.flatMap((s) => (s.images ?? []).map((i) => i.url));

/** Every picture url this property's pages still reference, for the image
 *  garbage collector. Normalized, so a picture on a section type that can't have
 *  one doesn't count — `pagesOf` drops it on read, so nothing renders it. */
export async function siteImageUrls(pid: string): Promise<string[]> {
  return pagesOf(await read(pid)).flatMap((p) => imageUrlsOf(p.sections));
}

/**
 * Delete a page and every scrap of text it owned, in every language.
 *
 * Returns the picture urls that went with it, for `queueImageCleanup` — the page
 * was the only thing referencing them, so nothing else will ever remove the R2
 * objects.
 */
export async function deletePage(pid: string, pageId: string): Promise<string[]> {
  const config = await read(pid);
  const pages = pagesOf(config);
  const page = pages.find((p) => p.id === pageId);
  if (!page || isHome(page)) return [];

  const dead = new Set(pageCopyKeys(page));
  const copy: Record<string, Record<string, string>> = {};
  for (const [lang, map] of Object.entries(config.copy)) {
    copy[lang] = Object.fromEntries(Object.entries(map).filter(([k]) => !dead.has(k)));
  }
  await write(pid, { ...config, pages: pages.filter((p) => p.id !== pageId), copy });
  return imageUrlsOf(page.sections);
}

/**
 * Replace one page's structure. Text is untouched — reordering or hiding a
 * section must never drop what's written in it.
 *
 * Returns the picture urls this save dropped, for `queueImageCleanup`. Removing
 * a picture IS this save (the editor drops it from its own state, see
 * `addSectionImages`), so diffing the stored structure against the incoming one
 * is the only place a deleted picture can be noticed.
 */
export async function savePageSections(
  pid: string,
  pageId: string,
  sections: SiteSection[],
): Promise<string[]> {
  const config = await read(pid);
  const pages = pagesOf(config);
  const before = pages.find((p) => p.id === pageId);
  if (!before) return [];
  const next = pages.map((p) =>
    p.id === pageId ? { ...p, sections: normalizeSections(sections, isHome(p)) } : p,
  );
  await write(pid, { ...config, pages: next });

  // Compare against the NORMALIZED result, not the raw input: a picture
  // normalizeSections threw away is just as orphaned as one the editor removed.
  const kept = new Set(imageUrlsOf(next.find((p) => p.id === pageId)!.sections));
  return imageUrlsOf(before.sections).filter((url) => !kept.has(url));
}

/**
 * Append uploaded images to one section.
 *
 * Removal and reordering are NOT here: images travel with the section structure,
 * so the editor drops or moves them in its own state and `savePageSections`
 * persists the result — the same path as removing a section. That also means the
 * alt text of a removed image is pruned by `saveSiteCopy` with no special case.
 *
 * Returns how many didn't fit, so the caller can say so rather than silently
 * dropping the tail of a batch.
 */
export async function addSectionImages(
  pid: string,
  pageId: string,
  sectionId: string,
  urls: string[],
): Promise<{ added: number; skipped: number }> {
  if (!urls.length) return { added: 0, skipped: 0 };
  const config = await read(pid);
  const pages = pagesOf(config);
  const page = pages.find((p) => p.id === pageId);
  const section = page?.sections.find((s) => s.id === sectionId);
  if (!page || !section || !SECTION_DEFS[section.type].images) {
    return { added: 0, skipped: urls.length };
  }

  const images = section.images ?? [];
  const room = Math.max(0, MAX_SECTION_IMAGES - images.length);
  const take = urls.slice(0, room);
  section.images = [...images, ...take.map((url) => ({ id: crypto.randomUUID(), url }))];

  await write(pid, { ...config, pages });
  return { added: take.length, skipped: urls.length - take.length };
}

/**
 * Replace one page's text in one language.
 *
 * Scoped to the keys that page owns, which is the difference between one page
 * and many: the copy map is shared, so replacing a whole language — which is
 * what this used to do — would wipe every other page's text the moment a hotel
 * saved the home page. Keys owned by no live page are dropped, so removing a
 * section or a page doesn't leave its copy behind for ever.
 */
export async function saveSiteCopy(
  pid: string,
  lang: string,
  pageId: string,
  text: Record<string, string>,
): Promise<void> {
  const config = await read(pid);
  const pages = pagesOf(config);
  const page = pages.find((p) => p.id === pageId);
  if (!page) return;

  const owned = new Set(pageCopyKeys(page));
  const live = new Set(pages.flatMap((p) => pageCopyKeys(p)));

  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.copy[lang] ?? {})) {
    // This editor is authoritative for its own keys (a cleared field means
    // cleared), and anything belonging to no page at all is garbage.
    if (owned.has(k) || !live.has(k)) continue;
    next[k] = v;
  }
  for (const [k, v] of Object.entries(text)) {
    const trimmed = v.trim();
    if (trimmed && owned.has(k)) next[k] = trimmed;
  }
  await write(pid, { ...config, copy: { ...config.copy, [lang]: next } });
}

// ---------------------------------------------------------------- footer

/** Raw footer structure + one language's text, for the editor. */
export async function getFooterRaw(
  pid: string,
  lang: string,
): Promise<{ footer: SiteFooter; text: Record<string, string>; baseText: Record<string, string> }> {
  const config = await read(pid);
  return {
    footer: normalizeFooter(config.footer),
    text: config.footerCopy?.[lang] ?? {},
    baseText: lang === DEFAULT_LANG ? {} : (config.footerCopy?.[DEFAULT_LANG] ?? {}),
  };
}

function resolveFooter(config: SiteConfig, lang: string): ResolvedFooter {
  const footer = normalizeFooter(config.footer);
  const base = config.footerCopy?.[DEFAULT_LANG] ?? {};
  const loc = config.footerCopy?.[lang] ?? {};
  const pick = (key: string) => (loc[key] || base[key] || "").trim();

  return {
    showContact: footer.showContact !== false,
    blurb: pick(footerBlurbKey()) || undefined,
    social: Object.entries(footer.social ?? {}).map(([platform, url]) => ({
      platform: platform as keyof typeof SOCIAL_LABEL,
      label: SOCIAL_LABEL[platform as keyof typeof SOCIAL_LABEL],
      url: url as string,
    })),
    // An unlabelled link would render as an empty anchor nobody can see, so a
    // link with no label in any language is dropped rather than shown blank.
    links: (footer.links ?? [])
      .map((l) => ({ label: pick(footerLinkKey(l.id)), url: l.url }))
      .filter((l) => l.label),
  };
}

/** Save footer structure and ONE language's text together. */
export async function saveFooter(
  pid: string,
  lang: string,
  footer: SiteFooter,
  text: Record<string, string>,
): Promise<void> {
  const config = await read(pid);
  const next = normalizeFooter(footer);
  const liveLinks = new Set((next.links ?? []).map((l) => l.id));
  const LINK_PREFIX = `${FOOTER_COPY_ID}.link_`;
  const isDeadLink = (key: string) =>
    key.startsWith(LINK_PREFIX) && !liveLinks.has(key.slice(LINK_PREFIX.length));

  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(text)) {
    const trimmed = v.trim();
    if (!trimmed || isDeadLink(k)) continue;
    cleaned[k] = trimmed;
  }

  // The link list is shared across languages, so removing a link on one tab has
  // to drop its label in EVERY language — otherwise the other languages keep an
  // orphaned label for a link that no longer exists.
  const copy: Record<string, Record<string, string>> = {};
  for (const [l, map] of Object.entries(config.footerCopy ?? {})) {
    if (l === lang) continue;
    copy[l] = Object.fromEntries(Object.entries(map).filter(([k]) => !isDeadLink(k)));
  }
  copy[lang] = cleaned;

  await write(pid, { ...config, footer: next, footerCopy: copy });
}

// ---------------------------------------------------------------- chrome

/** A page's header/footer link. */
export interface NavPage {
  slug: string;
  label: string;
}

/** The stored layout style, for the admin editor to show as selected. */
export async function getSiteStyle(pid: string): Promise<string | undefined> {
  return (await read(pid)).style;
}

/**
 * Switch the layout style.
 *
 * Content-safe by construction: it writes one field and leaves `pages` and
 * `copy` exactly as they were, so a hotel can try a style and switch back with
 * nothing to restore.
 */
export async function saveSiteStyle(pid: string, style: SiteStyleId): Promise<void> {
  const config = await read(pid);
  await write(pid, { ...config, style });
}

/** One KV read for everything the layout needs on every website page. */
export async function getSiteChrome(
  pid: string,
  lang: string,
): Promise<{
  hasRoomsSection: boolean;
  footer: ResolvedFooter;
  navPages: NavPage[];
  pageSlugs: string[];
  style: string | undefined;
}> {
  const config = await read(pid);
  const pages = pagesOf(config);
  const home = pages.find(isHome)!;
  const extra = pages.filter((p) => !isHome(p));

  return {
    hasRoomsSection: home.sections.some((s) => s.type === "rooms" && !s.hidden),
    // The layout reads this to style every website page. It rides along on the
    // chrome read the layout already does, rather than costing a second one.
    style: config.style,
    footer: resolveFooter(config, lang),
    // A page with no title in any language would be a blank menu item, so it's
    // left out of the nav rather than shown as a gap you can still click.
    navPages: extra
      .filter((p) => p.nav)
      .map((p) => ({ slug: p.slug, label: pageText(config, lang, p.id, "title") }))
      .filter((p) => p.label),
    // Every extra page, nav or not: the layout needs to know it's on one to keep
    // the browsing nav visible.
    pageSlugs: extra.map((p) => p.slug),
  };
}
