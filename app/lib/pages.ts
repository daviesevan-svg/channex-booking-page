// Website pages — slugs, ids, and the keys their text is stored under.
// Pure: the admin editor and the guest renderer both read this file.
//
// A page's identity is its `id`, not its slug. Renaming "about" to "our-story"
// has to keep the copy that's already written in eight languages, and a slug is
// exactly the thing a hotel changes its mind about.

import { imageAltKey, SECTION_DEFS, type SectionType, type SiteSection } from "./sections";

/** The home page. Stored with slug "" and this fixed id, so the copy written
 *  before pages existed keeps resolving. */
export const HOME_PAGE_ID = "home";

/** Enough for a hotel website; low enough that the nav stays a nav and one KV
 *  value stays a sensible size. */
export const MAX_PAGES = 12;

/**
 * Segments already claimed by the guest routes under `/:channelId`. A page slug
 * that collides is unreachable — React Router ranks static above dynamic, so
 * the funnel route wins and the hotel gets a page they can never open.
 *
 * Keep in sync with the `:channelId` children in routes.ts. The extra entries
 * are names we're likely to want later; reserving one costs nothing, and taking
 * one back from a hotel that already published it costs a redirect.
 */
export const RESERVED_PAGE_SLUGS = new Set([
  // live routes
  "p", // pages themselves live under /p/ — a page slugged "p" gives /p/p
  "rooms",
  "room",
  "contact",
  "extras",
  "vouchers",
  "voucher",
  "checkout",
  "confirmation",
  "manage",
  "review",
  // held back
  "book",
  "booking",
  "search",
  "home",
  "index",
  "admin",
  "api",
  "v1",
  "images",
  "assets",
  "feeds",
  "embed",
  "static",
]);

/** 2–48 chars: lowercase letters/digits/hyphens, no leading or trailing hyphen.
 *  Looser than the property slug's 3-char floor so "wc" or "spa" are allowed. */
const PAGE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])$/;

export function normalizePageSlug(input: string): string {
  return input.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
}

/** Human-readable reason `slug` can't be used for page `id`, or null if it can. */
export function pageSlugError(
  slug: string,
  id: string,
  pages: { id: string; slug: string }[],
): string | null {
  if (!slug) return "Enter a page address.";
  if (!PAGE_SLUG_RE.test(slug)) {
    return "Use 2–48 lowercase letters, numbers or hyphens (no spaces).";
  }
  if (RESERVED_PAGE_SLUGS.has(slug)) {
    return `"${slug}" is used by the booking pages — pick another address.`;
  }
  if (pages.some((p) => p.id !== id && p.slug === slug)) {
    return `"${slug}" is already used by another page.`;
  }
  return null;
}

/** Turn free text into a candidate slug. May be empty — callers validate. */
export function slugifyPage(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// ---- text keys ----

/** Page-level copy a hotel writes per language. */
export const PAGE_TEXT_FIELDS = ["title", "metaDescription"] as const;
export type PageTextField = (typeof PAGE_TEXT_FIELDS)[number];

/**
 * Where a page's own text lives in the shared copy map.
 *
 * Same `${owner}.${field}` shape as a section's, and the `page_` prefix keeps
 * the two apart: no section type starts with it, and generated section ids are
 * either a type name or a uuid.
 */
export function pageTextKey(pageId: string, field: PageTextField): string {
  return `page_${pageId}.${field}`;
}

/**
 * Every copy key a page owns — its own text, its sections' localized fields, and
 * one alt text per section image. The save path uses this both to know which
 * keys it may replace and to spot keys owned by nothing.
 *
 * The image alt keys are not optional here: a key missing from this list looks
 * like garbage to `saveSiteCopy` and gets dropped on the next save.
 */
export function pageCopyKeys(page: { id: string; sections: SiteSection[] }): string[] {
  const keys: string[] = PAGE_TEXT_FIELDS.map((f) => pageTextKey(page.id, f));
  for (const s of page.sections) {
    for (const f of SECDEF_FIELDS(s.type)) keys.push(`${s.id}.${f}`);
    for (const img of s.images ?? []) keys.push(`${s.id}.${imageAltKey(img.id)}`);
  }
  return keys;
}

function SECDEF_FIELDS(type: SectionType): string[] {
  return SECTION_DEFS[type].fields.filter((f) => f.localized).map((f) => f.key);
}

// ---- ids ----

/** A short, url-safe, stable page id. It ends up inside copy keys, so it must
 *  not contain a dot. */
export function newPageId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 0; i < 50; i++) {
    const id = `p${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    if (!used.has(id)) return id;
  }
  return `p${Date.now().toString(36)}`;
}

/**
 * The id for a newly added section.
 *
 * Built-ins are named after their type so copy written before a removal comes
 * back when it's re-added — but the copy map is shared across pages, so the
 * name has to carry the page too or an About page's heading would land on the
 * home page's. Home keeps the bare type, which is what's already stored.
 */
export function sectionIdFor(type: SectionType, pageId: string, taken: Iterable<string>): string {
  const base = pageId === HOME_PAGE_ID ? type : `${type}_${pageId}`;
  const used = new Set(taken);
  return used.has(base) ? crypto.randomUUID() : base;
}
