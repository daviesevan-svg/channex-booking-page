// Website sections — the catalogue, its defaults, and the shapes stored in KV.
// Pure: safe on the client, and the admin editor and the guest renderer both
// read this file so they can't drift.
//
// Sections are hardcoded here rather than authored by hotels. That keeps the
// whole thing typechecked, keeps rendering fast at the edge, and means nothing
// user-supplied is ever evaluated — which matters on a page that also takes
// card details.

import type { SiteFooter } from "./footer";

export const SECTION_TYPES = [
  "hero",
  "highlights",
  "rooms",
  "gallery",
  "facilities",
  "map",
  "contact",
  "reviews",
  "vouchers",
  "richText",
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

export interface SiteSection {
  /** Stable id. Built-in sections use their type as the id so a hotel's copy
   *  survives edits; a second section of the same type gets a uuid. */
  id: string;
  type: SectionType;
  hidden?: boolean;
  /** Non-text configuration — layout, counts, toggles. Language-independent. */
  settings?: Record<string, string | number | boolean>;
}

/** A section with its localized text merged in for one language. Lives here
 *  rather than beside the loader so client components can name the type without
 *  importing a `*.server` module (an unused one still breaks the client build). */
export interface ResolvedSection extends SiteSection {
  text: Record<string, string>;
}

export interface SitePage {
  /** Stable identity, so renaming the slug keeps the copy written under it.
   *  The home page's id is always "home" (see `HOME_PAGE_ID`). */
  id: string;
  /** "" is the home page; otherwise the last URL segment ("about", "dining"). */
  slug: string;
  /** Show this page in the header nav and the footer's link list. A page can be
   *  off the menu and still be linked to by hand. */
  nav?: boolean;
  sections: SiteSection[];
}

export interface SiteConfig {
  pages: SitePage[];
  /** lang → `${sectionId}.${field}` → text. Structure lives once (above) and
   *  copy lives per language, so translating can never reorder or delete a
   *  section. */
  copy: Record<string, Record<string, string>>;
  /** Footer structure. Chrome on every page, so it sits beside `pages` rather
   *  than inside one. */
  footer?: SiteFooter;
  /** The footer's per-language text, in its OWN namespace. Saving a language of
   *  `copy` replaces that whole language map (the sections editor renders every
   *  section, so a replace is right there) — sharing one map would mean the
   *  sections editor silently wiped the footer's text and vice versa. */
  footerCopy?: Record<string, Record<string, string>>;
}

// ---- field definitions ----

export type FieldKind = "text" | "textarea" | "number" | "boolean" | "select";

export interface SectionFieldDef {
  key: string;
  kind: FieldKind;
  /** Text fields live in the per-language copy map; everything else in settings. */
  localized?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  /** Default for a non-localized field. Localized fields fall back to a
   *  translated string at render time instead (see `headingKey`). */
  default?: string | number | boolean;
}

export interface SectionDef {
  type: SectionType;
  /** Admin i18n key naming the section. */
  labelKey: string;
  /** Guest i18n key used when the hotel hasn't written its own heading, so an
   *  untouched section still shows a translated title rather than nothing. */
  headingKey?: string;
  fields: SectionFieldDef[];
  /** Can a page hold more than one? Structural sections can't sensibly repeat. */
  repeatable?: boolean;
  /** Can't be removed. The hero carries the search form — a home page without
   *  it is a booking engine you can't book from. */
  required?: boolean;
  /**
   * Home page only. Two reasons, both real: the hero owns the search form's
   * state, and both of these read their copy from Website → Home, which is a
   * single set of fields — a second copy on another page would show the same
   * words, which is not what "add a section" looks like it does.
   */
  homeOnly?: boolean;
}

const HEADING: SectionFieldDef = { key: "heading", kind: "text", localized: true };

export const SECTION_DEFS: Record<SectionType, SectionDef> = {
  hero: {
    type: "hero",
    labelKey: "secHero",
    // Heading, intro and image already live in Website → Home (they also feed
    // the plain booking page). Reused here rather than duplicated, so there's
    // one place to edit them.
    fields: [{ key: "layout", kind: "select", options: ["split", "wide"], default: "split" }],
    required: true,
    homeOnly: true,
  },
  highlights: {
    type: "highlights",
    labelKey: "secHighlights",
    // Also from Website → Home — the three short selling points.
    fields: [],
    homeOnly: true,
  },
  rooms: {
    type: "rooms",
    labelKey: "secRooms",
    headingKey: "secRoomsHeadingDefault",
    fields: [
      HEADING,
      { key: "intro", kind: "textarea", localized: true },
      { key: "limit", kind: "number", min: 1, max: 24, default: 6 },
    ],
  },
  gallery: {
    type: "gallery",
    labelKey: "secGallery",
    headingKey: "photoGallery",
    fields: [HEADING, { key: "limit", kind: "number", min: 1, max: 40, default: 12 }],
  },
  facilities: {
    type: "facilities",
    labelKey: "secFacilities",
    headingKey: "facilitiesHeading",
    fields: [HEADING],
  },
  map: {
    type: "map",
    labelKey: "secMap",
    headingKey: "secMapHeadingDefault",
    fields: [
      HEADING,
      { key: "directions", kind: "textarea", localized: true },
      { key: "zoom", kind: "number", min: 10, max: 19, default: 15 },
    ],
  },
  contact: {
    type: "contact",
    labelKey: "secContact",
    headingKey: "secContactHeadingDefault",
    fields: [
      HEADING,
      { key: "intro", kind: "textarea", localized: true },
      { key: "showForm", kind: "boolean", default: true },
    ],
  },
  reviews: {
    type: "reviews",
    labelKey: "secReviews",
    headingKey: "guestReviews",
    fields: [
      HEADING,
      { key: "limit", kind: "number", min: 1, max: 12, default: 4 },
      { key: "minStars", kind: "number", min: 1, max: 5, default: 1 },
    ],
  },
  vouchers: {
    type: "vouchers",
    labelKey: "secVouchers",
    headingKey: "vouchersTeaser",
    fields: [HEADING, { key: "body", kind: "textarea", localized: true }],
  },
  richText: {
    type: "richText",
    labelKey: "secRichText",
    fields: [
      HEADING,
      { key: "body", kind: "textarea", localized: true },
      { key: "align", kind: "select", options: ["left", "center"], default: "left" },
    ],
    repeatable: true,
  },
};

/** The order the booking page has always rendered in. Used when the website
 *  layer is off, so that page is byte-for-byte what it was. */
export const LEGACY_SECTIONS: SiteSection[] = [
  { id: "hero", type: "hero" },
  { id: "highlights", type: "highlights" },
  { id: "facilities", type: "facilities" },
  { id: "reviews", type: "reviews" },
  { id: "vouchers", type: "vouchers" },
  { id: "gallery", type: "gallery" },
];

/** What a hotel gets the moment they switch the website on: every section that
 *  can be filled from content they already have, in a sensible order. Nothing
 *  to configure before it looks like a website. */
export const DEFAULT_WEBSITE_SECTIONS: SiteSection[] = [
  { id: "hero", type: "hero" },
  { id: "highlights", type: "highlights" },
  { id: "rooms", type: "rooms" },
  { id: "gallery", type: "gallery" },
  { id: "facilities", type: "facilities" },
  { id: "map", type: "map" },
  { id: "contact", type: "contact" },
  { id: "reviews", type: "reviews" },
  { id: "vouchers", type: "vouchers" },
];

/** A setting with its default applied and its type checked — a hand-edited KV
 *  value can't put a string where the renderer expects a number. */
export function settingOf<T extends string | number | boolean>(
  section: SiteSection,
  key: string,
  fallback: T,
): T {
  const raw = section.settings?.[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== typeof fallback) return fallback;
  return raw as T;
}

/** Clamp a numeric setting to the range its field declares. */
export function numberSetting(section: SiteSection, key: string, fallback: number): number {
  const def = SECTION_DEFS[section.type].fields.find((f) => f.key === key);
  const raw = settingOf(section, key, fallback);
  const n = Number.isFinite(raw) ? raw : fallback;
  const min = def?.min ?? 1;
  const max = def?.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Drop anything a hand-edited or out-of-date KV value could contain: unknown
 * types, duplicate ids, and duplicates of a section that can't repeat.
 *
 * `home` is false for an extra page, which changes two things: home-only
 * sections are dropped rather than rendered with the home page's copy, and the
 * hero isn't force-inserted — an About page doesn't need a search form.
 */
export function normalizeSections(input: SiteSection[], home = true): SiteSection[] {
  const seenIds = new Set<string>();
  const seenTypes = new Set<SectionType>();
  const out: SiteSection[] = [];
  for (const s of input) {
    if (!s || !SECTION_TYPES.includes(s.type)) continue;
    if (!home && SECTION_DEFS[s.type].homeOnly) continue;
    if (!s.id || seenIds.has(s.id)) continue;
    if (!SECTION_DEFS[s.type].repeatable && seenTypes.has(s.type)) continue;
    seenIds.add(s.id);
    seenTypes.add(s.type);
    out.push({ id: s.id, type: s.type, hidden: s.hidden === true, settings: s.settings ?? {} });
  }
  if (!home) return out;
  // A required section can never be dropped or hidden, however the list arrived
  // — a saved layout without the hero would be a home page you can't book from.
  for (const [type, def] of Object.entries(SECTION_DEFS) as [SectionType, SectionDef][]) {
    if (!def.required) continue;
    const found = out.find((s) => s.type === type);
    if (found) found.hidden = false;
    else out.unshift({ id: type, type, hidden: false, settings: {} });
  }
  return out;
}

/** Which types can still be added to a page. */
export function addableTypes(sections: SiteSection[], home = true): SectionType[] {
  const used = new Set(sections.map((s) => s.type));
  return SECTION_TYPES.filter((t) => {
    const def = SECTION_DEFS[t];
    if (!home && def.homeOnly) return false;
    return def.repeatable || !used.has(t);
  });
}

/** What an extra page starts with: one block of text the hotel then writes.
 *  Anything else is a deliberate addition rather than something to delete. */
export const DEFAULT_PAGE_SECTIONS: SectionType[] = ["richText"];
