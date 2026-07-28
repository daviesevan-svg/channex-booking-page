// Website page storage — one KV key per property (`site:{pid}`).
//
// Structure (which sections, in what order, with what settings) is stored once
// and is language-independent. Text lives in a per-language map keyed by
// `${sectionId}.${field}`. That split is the whole point: editing German can
// never reorder or delete a section, and each field falls back to the default
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
  DEFAULT_WEBSITE_SECTIONS,
  LEGACY_SECTIONS,
  normalizeSections,
  SECTION_DEFS,
  type SiteConfig,
  type SiteSection,
} from "./sections";

const key = (pid: string) => `site:${pid}`;
const HOME = "";

/** A section with its localized text already merged for one language. */
export interface ResolvedSection extends SiteSection {
  text: Record<string, string>;
}

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
    };
  } catch {
    return empty();
  }
}

async function write(pid: string, config: SiteConfig): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(key(pid), JSON.stringify(config));
}

function homeOf(config: SiteConfig): SiteSection[] | null {
  const page = config.pages.find((p) => p.slug === HOME);
  return page ? normalizeSections(page.sections) : null;
}

/** The home page's sections, for the admin editor (no text merged in). Returns
 *  the default layout when the hotel hasn't customised it yet, so the editor
 *  shows the page they can actually see rather than an empty list. */
export async function getHomeSections(pid: string): Promise<SiteSection[]> {
  return homeOf(await read(pid)) ?? normalizeSections(DEFAULT_WEBSITE_SECTIONS);
}

/** Raw text for one language, for the editor (no fallback — the editor must
 *  show what IS set in that language, with the default language as a hint). */
export async function getSiteCopyRaw(pid: string, lang: string): Promise<Record<string, string>> {
  return (await read(pid)).copy[lang] ?? {};
}

/**
 * The sections to render, with text resolved for `lang`.
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
  if (!websiteEnabled) {
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
  const config = await read(pid);
  const sections = homeOf(config) ?? normalizeSections(DEFAULT_WEBSITE_SECTIONS);
  const base = config.copy[DEFAULT_LANG] ?? {};
  const loc = config.copy[lang] ?? {};

  return sections
    .filter((s) => !s.hidden)
    .map((s) => {
      const text: Record<string, string> = {};
      for (const f of SECTION_DEFS[s.type].fields) {
        if (!f.localized) continue;
        // Per FIELD fallback, not per section — a translated heading with an
        // untranslated body should still show the body.
        const v = loc[`${s.id}.${f.key}`] || base[`${s.id}.${f.key}`];
        if (v) text[f.key] = v;
      }
      return { ...s, text };
    });
}

/** Replace the home page's structure. Text is untouched — reordering or hiding
 *  a section must never drop what's written in it. */
export async function saveHomeSections(pid: string, sections: SiteSection[]): Promise<void> {
  const config = await read(pid);
  const next = normalizeSections(sections);
  const others = config.pages.filter((p) => p.slug !== HOME);
  await write(pid, { ...config, pages: [...others, { slug: HOME, sections: next }] });
}

/** Replace one language's text. Keys for sections that no longer exist are
 *  dropped, so removing a section doesn't leave its copy behind for ever. */
export async function saveSiteCopy(
  pid: string,
  lang: string,
  text: Record<string, string>,
): Promise<void> {
  const config = await read(pid);
  const live = new Set((homeOf(config) ?? normalizeSections(DEFAULT_WEBSITE_SECTIONS)).map((s) => s.id));
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(text)) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    if (!live.has(k.split(".")[0])) continue;
    next[k] = trimmed;
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

/** Guest-facing: the footer with text resolved for `lang`, per field, falling
 *  back to the default language so a half-translated footer still reads. */
export async function getFooterFor(pid: string, lang: string): Promise<ResolvedFooter> {
  const config = await read(pid);
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

/** One KV read for everything the layout needs on every website page. */
export async function getSiteChrome(
  pid: string,
  lang: string,
): Promise<{ hasRoomsSection: boolean; footer: ResolvedFooter }> {
  const [sections, footer] = await Promise.all([
    getRenderSections(pid, lang, true),
    getFooterFor(pid, lang),
  ]);
  return { hasRoomsSection: sections.some((s) => s.type === "rooms"), footer };
}
