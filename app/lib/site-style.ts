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

// Type-only, both ways: sections.ts names SiteStyleId and this file names
// SectionType. `import type` is erased, so the cycle never exists at runtime.
import type { SectionType } from "./sections";

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
  /**
   * Container around the search card, for a hero whose photo bleeds past the
   * band's gutters — the card still has to line up with the rest of the page.
   *
   * Empty for a style whose page shell already constrains the width, and the
   * empty case emits no element at all (same reason as `band`).
   */
  heroInner: string;
  /**
   * Container around an extra page's `<h1>`.
   *
   * The page title is rendered by the route, not by the section list, so it gets
   * no band — without this a band style leaves it with no gutters and nothing
   * between it and the header. Empty emits no element.
   */
  pageHead: string;
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

/**
 * How the hero arranges itself.
 *
 * "stacked" is copy, then the search card underneath, with the hotel's own
 * `layout` setting deciding whether a photo sits beside the copy.
 *
 * "overlay" puts the copy ON the photo and ignores that setting. Overriding a
 * hotel's choice is deliberate: the arrangement of the page is exactly what a
 * template is for, and the setting comes back untouched if they switch style
 * again.
 */
export type HeroArrangement = "stacked" | "overlay";

export interface SiteStyleDef {
  id: SiteStyleId;
  /** Admin i18n key naming the style. */
  labelKey: string;
  hero: HeroArrangement;
  /**
   * Design tokens the style overrides, applied to the guest wrapper.
   *
   * This is how a template reaches the parts of the journey the section renderer
   * never touches. The tokens in app.css compile to `var()` references — a
   * `rounded-card` anywhere becomes `border-radius: var(--radius-card)` — so one
   * entry here restyles the booking funnel, the voucher flow, the manage pages
   * and the header and footer at the same time as the website, with no changes at
   * any of those call sites.
   *
   * That is exactly what the token conversion was for. Prefer a var over a slot
   * whenever the difference is expressible as a token: a slot only reaches the
   * components that ask for it, and the funnel deliberately doesn't.
   */
  vars?: Record<string, string>;
  /**
   * Full-width bands behind each section, cycled by position.
   *
   * Undefined means NO wrapper element is emitted at all — not a wrapper with no
   * classes. That's what keeps `classic` rendering the markup it always did,
   * which is the only way a style refactor can be proven to change nothing.
   */
  band?: {
    outer: string[];
    inner: string;
    /**
     * Section types whose band gets NO inner container, so they run the full
     * width of the viewport.
     *
     * A list rather than a flag per section, so "which things bleed" is a
     * property of the design and adding one is an edit to this table. A bleeding
     * section is responsible for its own gutters — see the `heroInner` slot.
     */
    bleed?: SectionType[];
  };
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
  heroInner: "",
  pageHead: "",
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
const STYLE_DEFS: Record<
  SiteStyleId,
  {
    labelKey: string;
    hero?: HeroArrangement;
    band?: SiteStyleDef["band"];
    vars?: Record<string, string>;
    slots: Partial<StyleSlots>;
  }
> = {
  classic: { labelKey: "styleClassic", slots: {} },

  // Full-width chapters instead of one narrow column: the page alternates
  // surfaces, headings are centred small-caps sans over serif prose, corners are
  // square, and the photography runs edge to edge. Same sections, same words —
  // the hotel's content is untouched by any of this.
  editorial: {
    labelKey: "styleEditorial",
    hero: "overlay",
    // Square corners everywhere, in one place. These reach the whole journey —
    // results, room detail, extras, checkout, confirmation, the voucher flow, the
    // manage pages, the header and the footer — because they all draw their
    // corners from these tokens. A guest shouldn't cross from a square website
    // into rounded cards the moment they pick a room.
    //
    // `--radius-mark` (the diamond) and Tailwind's own `rounded-full` are left
    // alone deliberately: the marker is the brand, and squaring the stepper dots
    // and status pills reads as broken rather than as a style.
    vars: {
      "--radius-chip": "0px",
      "--radius-chip-lg": "0px",
      "--radius-control": "0px",
      "--radius-field": "0px",
      "--radius-card": "0px",
      "--radius-card-lg": "0px",
      "--radius-panel": "0px",
      "--radius-panel-lg": "0px",
      "--radius-well": "0px",
      "--radius-well-lg": "0px",
    },
    band: {
      // Two entries, so sections alternate. Position drives it, which means
      // reordering sections in the admin re-stripes the page automatically.
      outer: ["", "bg-surface-alt"],
      inner: "mx-auto max-w-[1160px] px-7 py-[clamp(44px,6vw,80px)]",
      // The cover photo runs the full width of the viewport. Boxed inside the
      // band's gutters it read as a picture in a frame rather than as a cover,
      // which is the whole point of the arrangement.
      bleed: ["hero"],
    },
    slots: {
      // The bands own the gutters and the vertical rhythm now, so the page shell
      // and the per-section margin both have to get out of the way — otherwise
      // every section is indented twice and spaced twice.
      page: "",
      gap: "",
      // Sections run the full band width; only prose stays narrow, and centred.
      measure: "",
      measureProse: "mx-auto max-w-[760px]",

      h1: "font-serif text-display-2xl font-normal italic leading-[1.15]",
      h2: "font-sans text-title-md font-semibold uppercase tracking-[0.16em]",
      h2Inline: "font-sans text-title-sm font-semibold uppercase tracking-[0.12em]",
      h3: "font-sans text-title-xs font-semibold uppercase tracking-[0.08em]",
      heroDisplay: "font-serif font-normal italic leading-[1.08] tracking-[-0.01em]",
      // The hero bleeds, so the search card carries the page's gutters itself and
      // the bottom padding the band would have given the section.
      heroInner: "mx-auto max-w-[1160px] px-7 pb-[clamp(44px,6vw,80px)]",
      pageHead: "mx-auto max-w-[1160px] px-7 pt-[clamp(44px,6vw,80px)]",
      headingAlign: "text-center",

      // Cards lose their box and keep a hairline: a review reads as a pull quote
      // and a room as a plate, not as a widget.
      card: "rounded-none border-t border-line bg-transparent",
      panel: "rounded-none bg-transparent",
      // The strip keeps its border — the search card has to stay a legible
      // control, and a borderless one on a tinted band disappears.
      strip: "rounded-none border border-line bg-surface",
      media: "rounded-none",
      mediaLarge: "rounded-none",
      ctaOutline: "rounded-none border border-accent",
      linkOutline: "rounded-none border border-accent",

      highlightsGrid: "grid-cols-1 gap-8 sm:grid-cols-3",
      facilitiesGrid: "grid-cols-2 gap-x-10 gap-y-3 sm:grid-cols-3 lg:grid-cols-4",
      reviewsGrid: "grid-cols-1 gap-8 sm:grid-cols-2",
      // A tight square mosaic rather than a widely spaced 4-up grid.
      galleryGrid: "grid-cols-2 gap-1.5 sm:grid-cols-3",
      galleryTile: "aspect-square",
      // Two tall plates. Fewer, larger rooms per row is most of the difference.
      roomsGrid: "grid-cols-1 gap-10 sm:grid-cols-2",
      roomPhoto: "aspect-[4/5]",
    },
  },
};

export const SITE_STYLES: Record<SiteStyleId, SiteStyleDef> = Object.fromEntries(
  SITE_STYLE_IDS.map((id) => [
    id,
    {
      id,
      labelKey: STYLE_DEFS[id].labelKey,
      hero: STYLE_DEFS[id].hero ?? "stacked",
      band: STYLE_DEFS[id].band,
      vars: STYLE_DEFS[id].vars,
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
