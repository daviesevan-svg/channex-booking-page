// Website layout styles — the "how it looks" half of a template.
//
// A template is a section STACK plus one of these. The stack decides what a page
// says; the style decides how it's arranged. They're deliberately separate:
// switching style must never touch a hotel's content, and reordering sections
// must never change the design.
//
// Every visual decision the section renderer used to hardcode lives here as a
// named slot. That's the whole mechanism — a new style is a table of class
// strings, not new components, so two styles can't drift apart in behaviour and
// nothing new has to be typechecked to add one.
//
// `classic` holds the exact strings the renderer shipped before this file
// existed, and is the base every other style is merged over. If a slot is
// missing from a style, the classic value shows through — a style is a delta,
// not a fresh start.

/** Class strings the renderer asks for by role. */
export interface StyleSlots {
  // ---- shell and rhythm ----
  /** The `<main>` around the whole section list. */
  page: string;
  /** Vertical space above each section. Empty when a band supplies its own. */
  gap: string;
  /** The narrow column most sections sit in. */
  measure: string;
  /** The narrower column prose sits in. */
  measureProse: string;

  // ---- type ----
  h1: string;
  h2: string;
  /** A heading inside a strip or card, smaller than a section heading. */
  h2Inline: string;
  h3: string;
  /** The hero's display heading, minus its size (the hero picks that by layout). */
  heroDisplay: string;
  /** Alignment applied to section headings — the visible half of a centred style. */
  headingAlign: string;

  // ---- surfaces ----
  /** A small card: one review, the contact form. */
  card: string;
  /** A larger card that holds an image: a room. */
  panel: string;
  /** A full-width strip: the vouchers teaser, the search card. */
  strip: string;
  /** Corner treatment for images in a grid or column. */
  media: string;
  /** Corner treatment for a large single image or the map box. */
  mediaLarge: string;
  /** The outlined button on the vouchers strip. */
  ctaOutline: string;
  /** The smaller outlined link on a room card. */
  linkOutline: string;

  // ---- grids ----
  highlightsGrid: string;
  facilitiesGrid: string;
  reviewsGrid: string;
  galleryGrid: string;
  /** Aspect ratio of a gallery tile. */
  galleryTile: string;
  roomsGrid: string;
  /** Aspect ratio of a room card's photo. */
  roomPhoto: string;
}

export interface SiteStyleDef {
  id: SiteStyleId;
  /** Admin i18n key naming the style. */
  labelKey: string;
  /**
   * Full-width bands behind each section, cycled by position.
   *
   * Undefined means NO wrapper element is emitted at all — not a wrapper with no
   * classes. That's what keeps `classic` rendering the markup it always did,
   * which is the only way a style refactor can be proven to change nothing.
   */
  band?: { outer: string[]; inner: string };
  slots: StyleSlots;
}

export const SITE_STYLE_IDS = ["classic", "editorial"] as const;
export type SiteStyleId = (typeof SITE_STYLE_IDS)[number];

export const DEFAULT_SITE_STYLE: SiteStyleId = "classic";

/** Every string the renderer hardcoded before styles existed. Don't "tidy" these
 *  — they are a snapshot, and a hotel's live page is the test. */
const CLASSIC: StyleSlots = {
  page: "mx-auto max-w-[1160px] px-7 pb-[72px] pt-16",
  gap: "mt-12",
  measure: "max-w-[920px]",
  measureProse: "max-w-[720px]",

  h1: "font-serif text-display-3xl font-medium leading-[1.1] tracking-[-0.02em]",
  h2: "font-serif text-title-3xl font-semibold",
  h2Inline: "font-serif text-title-xl font-semibold",
  h3: "font-serif text-title-sm font-semibold",
  heroDisplay: "font-serif font-medium leading-[1.05] tracking-[-0.02em]",
  headingAlign: "",

  card: "rounded-card-lg border border-line bg-surface",
  panel: "rounded-panel border border-line bg-surface",
  strip: "rounded-panel-lg border border-line bg-surface",
  media: "rounded-card-lg",
  mediaLarge: "rounded-panel-lg",
  ctaOutline: "rounded-card border border-accent",
  linkOutline: "rounded-control border border-accent",

  highlightsGrid: "grid-cols-1 gap-[18px] sm:grid-cols-3",
  facilitiesGrid: "grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3",
  reviewsGrid: "grid-cols-1 gap-[18px] sm:grid-cols-2",
  galleryGrid: "grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4",
  galleryTile: "aspect-[4/3]",
  roomsGrid: "grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3",
  roomPhoto: "aspect-[3/2]",
};

/** A style is a delta over classic, so adding one means writing only what differs. */
const STYLE_DEFS: Record<SiteStyleId, { labelKey: string; band?: SiteStyleDef["band"]; slots: Partial<StyleSlots> }> = {
  classic: { labelKey: "styleClassic", slots: {} },
  editorial: { labelKey: "styleEditorial", slots: {} },
};

export const SITE_STYLES: Record<SiteStyleId, SiteStyleDef> = Object.fromEntries(
  SITE_STYLE_IDS.map((id) => [
    id,
    {
      id,
      labelKey: STYLE_DEFS[id].labelKey,
      band: STYLE_DEFS[id].band,
      slots: { ...CLASSIC, ...STYLE_DEFS[id].slots },
    },
  ]),
) as Record<SiteStyleId, SiteStyleDef>;

/** A stored (or hand-edited, or from a newer deploy) style id, made safe. */
export function siteStyle(id: string | undefined): SiteStyleDef {
  return SITE_STYLES[(id ?? "") as SiteStyleId] ?? SITE_STYLES[DEFAULT_SITE_STYLE];
}

/** Join class fragments, dropping the empty ones. A style that clears a slot
 *  must not leave a double space behind — the whole no-op proof is a string
 *  comparison against markup that never had one. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
