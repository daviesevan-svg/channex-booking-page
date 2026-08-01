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

  // ---- the funnel ----
  // Derived by counting what results, detail, extras, checkout, confirmation,
  // the voucher flow and the manage pages actually draw. Those pages reuse
  // `card`, `panel` and `strip` above for their surfaces — one vocabulary, so a
  // template that says "rooms are plates, not cards" means it everywhere. These
  // five are the constructs the website has no equivalent of.
  /**
   * A tinted inset inside a panel: a policy note, a total block.
   *
   * Rarer than the first audit suggested. Counting the STRING said twelve; going
   * back and looking at what each one was attached to said eight of them are
   * text inputs and only one is an inset. Count constructs, not substrings.
   */
  well: string;
  /** Input chrome. Padding stays at the call site — it varies by field size. ×8 */
  field: string;
  /** The money button: search, select, continue, pay. ×9 */
  btnPrimary: string;
  /** The quieter one beside it. */
  btnSecondary: string;
  /**
   * A hairline between rows — the funnel's most common construct at 28 uses.
   *
   * Colour and style only; the call site keeps `border-t` / `border-b`, because
   * which edge a rule sits on is about the content, not the template.
   */
  rule: string;

  // ---- the half-bleed row ----
  // `richText` and `map` normally put their picture in a column beside the prose,
  // inside the page gutters. A style can instead run the picture to one page edge
  // and the prose to the other. Empty means the in-gutter layout, which is what
  // keeps every existing site as it was.
  //
  // Which side the picture takes comes from the hotel's existing `imageSide`
  // field, so three rich-text sections that alternate it weave down the page.
  /** The 50/50 row. Empty = don't use this layout at all. */
  splitRow: string;
  /** The picture half. It fills, so it needs a height rather than a ratio. */
  splitMedia: string;
  /** The prose half, which carries the gutters the band no longer provides. */
  splitProse: string;

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

/**
 * How the vouchers teaser is built.
 *
 * "strip" is a bordered row with the copy left and the button right. "band" runs
 * it the full width of the viewport with the property's photograph behind it,
 * darkened, and the copy reversed out and centred.
 */
export type VouchersArrangement = "strip" | "band";

export interface SiteStyleDef {
  id: SiteStyleId;
  /** Admin i18n key naming the style. */
  labelKey: string;
  hero: HeroArrangement;
  vouchers: VouchersArrangement;
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
   * Heading typography, for every guest page rather than only the sections.
   *
   * Separate from `vars` because its presence is the switch: the wrapper gets a
   * `data-headings` attribute only when a style declares this, and one generic
   * rule in app.css reads these properties. A style that says nothing about type
   * keeps the per-call-site utilities, which is what leaves `classic` — with its
   * several different tracking values — exactly as it was.
   *
   * Values are plain CSS, so `var(--font-sans)` composes with the theme's chosen
   * font pair rather than hardcoding a family. See the rule in app.css for the
   * property names and their fallbacks.
   */
  headings?: Record<string, string>;
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

export const SITE_STYLE_IDS = ["classic", "editorial", "welcoming"] as const;
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

  well: "rounded-control border border-line-alt bg-surface-alt",
  // Same string as `well` in classic — they only diverge in a style that treats
  // a form control differently from a note, which is most of them.
  field: "rounded-control border border-line-alt bg-surface-alt",
  btnPrimary: "rounded-card bg-accent text-white hover:bg-accent-deep",
  btnSecondary: "rounded-control border border-line-alt bg-surface-alt",
  rule: "border-divider",

  splitRow: "",
  splitMedia: "",
  splitProse: "",

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
    vouchers?: VouchersArrangement;
    band?: SiteStyleDef["band"];
    vars?: Record<string, string>;
    headings?: Record<string, string>;
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
    // Serif italic for the page title, small-caps sans below it — on every guest
    // page, not just the sections. The section slots below say the same thing for
    // the parts of the website that set their own classes; this reaches the
    // funnel, the voucher flow and the manage pages, which don't.
    headings: {
      "--h1-style": "italic",
      "--h1-weight": "400",
      "--h1-tracking": "-0.01em",
      "--h2-font": "var(--font-sans)",
      "--h2-weight": "600",
      "--h2-case": "uppercase",
      "--h2-tracking": "0.16em",
      // An h3 here is often a room title at 24px, where 0.16em sprawls.
      "--h3-tracking": "0.08em",
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

  // Big serif headings on white, photographs to the edge of the screen, and no
  // card outlines: the house shown in full-width chapters rather than tiles.
  //
  // For the properties Classic serves least well — B&Bs, guesthouses, farm
  // stays — where the host's own words and a handful of photographs do the
  // selling, and there is often little content on day one. Hence the emphasis on
  // sections that look deliberate while nearly empty.
  //
  // Corners are 2px rather than 0. Editorial owns square; 2px reads as trimmed,
  // and it leaves the round status pills and the diamond mark looking like two
  // deliberate exceptions rather than four.
  welcoming: {
    labelKey: "styleWelcoming",
    hero: "overlay",
    vouchers: "band",
    band: {
      // White and off-white, not the warm page tone. The page colour survives in
      // the hairlines, the chips and the striped photo placeholder.
      outer: ["bg-surface", "bg-surface-alt"],
      inner: "mx-auto max-w-[1120px] px-10 py-20",
      // The map is NOT here: its half-bleed row is the one part of the design
      // still to build, and the handoff sanctions the in-gutter fallback.
      bleed: ["hero", "gallery", "vouchers", "richText"],
    },
    vars: {
      // White, not the warm page tone. This is the one place a style overrides a
      // THEME value, and it's deliberate: "big serif headings on white" is the
      // design, and the bands, the funnel and the manage pages all sit on this.
      // A hotel on a custom colour loses their page tint while this template is
      // selected — their accent is untouched, and switching template restores it.
      "--page": "#ffffff",
      "--radius-control": "2px",
      "--radius-field": "2px",
      "--radius-card": "2px",
      "--radius-card-lg": "2px",
      "--radius-panel": "2px",
      "--radius-panel-lg": "2px",
      "--radius-well": "2px",
      "--radius-well-lg": "2px",
      "--radius-chip-lg": "8px",
    },
    headings: {
      "--h1-weight": "700",
      "--h1-tracking": "-0.02em",
      "--h2-weight": "700",
      "--h2-tracking": "-0.02em",
      "--h3-weight": "600",
      "--h3-tracking": "-0.015em",
      // The one place small caps are used: the wordmark. Everywhere else,
      // uppercase headings are Editorial's signature and read corporate here.
      "--wordmark-case": "uppercase",
      "--wordmark-tracking": "0.14em",
    },
    slots: {
      // The bands own the gutters and the rhythm.
      page: "",
      gap: "",
      measure: "",
      measureProse: "max-w-[640px]",

      h1: "font-serif text-display-3xl font-bold leading-[1.12]",
      h2: "font-serif text-display-xl font-bold",
      h2Inline: "font-serif text-display-xs font-semibold",
      h3: "font-serif text-title-xl font-semibold",
      heroDisplay: "font-serif font-bold leading-[1.08]",
      // The search card overlaps the hero photograph by 36px.
      heroInner: "mx-auto max-w-[1120px] px-10 pb-20 -mt-9",
      pageHead: "mx-auto max-w-[1120px] px-10 py-16 text-center",
      headingAlign: "",

      // No card chrome anywhere: a review is an indented quote, a room is a
      // photograph with a caption. Only the things carrying money keep a border.
      card: "border-l border-line bg-transparent",
      panel: "bg-transparent",
      // A shade off the white page, so the summary and the search card read as
      // blocks rather than as an outline drawn on nothing.
      strip: "rounded-panel border border-line-alt bg-surface-alt",
      media: "rounded-card",
      // A large single image or the map bleeds, so it has no corners to round.
      mediaLarge: "rounded-none",
      ctaOutline: "rounded-card border border-accent",
      // Not a box — a lettered link with a rule under it.
      linkOutline: "border-b border-accent",

      // The funnel keeps its borders where money is involved and loses them
      // everywhere else, matching the website's plates-not-cards logic.
      // A note is a tinted block with an accent rule down its left edge.
      well: "rounded-control border-l-2 border-accent bg-surface-alt",
      // Text fields are underline-only, per the design — the one exception is
      // the card fields, which stay fully boxed so the payment area reads as an
      // enclosed control. Those are Stripe's own iframe, so they already do.
      field: "rounded-none border-0 border-b border-line-alt bg-transparent",
      btnPrimary: "rounded-card bg-accent text-white hover:bg-accent-deep",
      btnSecondary: "rounded-control border border-line-alt bg-surface",
      rule: "border-line",

      splitRow: "grid grid-cols-1 items-stretch lg:grid-cols-2",
      splitMedia: "min-h-[400px] lg:min-h-[440px]",
      // 608 = the design's 480 of prose plus its 64 of padding either side, so
      // the text column measures what the mock does rather than 128 less.
      splitProse: "flex flex-col justify-center px-5 py-12 lg:mx-auto lg:max-w-[608px] lg:px-16",

      highlightsGrid: "grid-cols-1 gap-12 sm:grid-cols-3",
      facilitiesGrid: "grid-cols-1 gap-x-16 gap-y-0 sm:grid-cols-2",
      reviewsGrid: "grid-cols-1 gap-16 sm:grid-cols-2",
      // Three across, no gutters, straight to both page edges.
      galleryGrid: "grid-cols-2 gap-0 sm:grid-cols-3",
      galleryTile: "aspect-[4/3]",
      roomsGrid: "grid-cols-1 gap-x-10 gap-y-14 sm:grid-cols-2",
      roomPhoto: "aspect-[4/3]",
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
      vouchers: STYLE_DEFS[id].vouchers ?? "strip",
      band: STYLE_DEFS[id].band,
      vars: STYLE_DEFS[id].vars,
      headings: STYLE_DEFS[id].headings,
      slots: { ...CLASSIC, ...STYLE_DEFS[id].slots },
    },
  ]),
) as Record<SiteStyleId, SiteStyleDef>;

/** A stored (or hand-edited, or from a newer deploy) style id, made safe. */
export function siteStyle(id: string | undefined): SiteStyleDef {
  return SITE_STYLES[(id ?? "") as SiteStyleId] ?? SITE_STYLES[DEFAULT_SITE_STYLE];
}

/**
 * The style as literal values an email can use.
 *
 * Emails can't read a custom property — Outlook has no support for them, which is
 * why the renderer writes inline styles — so the template has to arrive as plain
 * numbers and keywords. Without this, a guest books through a square, small-caps
 * site and gets a rounded confirmation email: the last incoherent step in the
 * journey.
 */
export interface EmailBrand {
  /** Already email-safe hex, from the theme. Unrelated to the style. */
  accent: string;
  radiusButton: number;
  radiusPanel: number;
  radiusShell: number;
  /** `text-transform` for the details block's labels. */
  labelCase: string;
  labelTracking: string;
}

/** The email's own long-standing values. NOT read from the radius tokens: these
 *  were picked for email clients, and only happen to sit near the web ones. What
 *  the style contributes is the CHANGE, below. */
const EMAIL_DEFAULTS = { radiusButton: 10, radiusPanel: 12, radiusShell: 14 };

/**
 * Fold a style into email-safe values.
 *
 * Radii are read from the style's own token overrides rather than restated, so
 * squaring the site and squaring its emails can't drift apart — there is one
 * place that says "this template has no corners".
 */
export function emailBrandFor(accent: string, styleId: string | undefined): EmailBrand {
  const style = siteStyle(styleId);
  const vars = style.vars ?? {};
  const px = (token: string, fallback: number) => {
    const raw = vars[token];
    if (!raw) return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? Math.max(0, n) : fallback;
  };
  return {
    accent,
    radiusButton: px("--radius-control", EMAIL_DEFAULTS.radiusButton),
    radiusPanel: px("--radius-card", EMAIL_DEFAULTS.radiusPanel),
    radiusShell: px("--radius-card-lg", EMAIL_DEFAULTS.radiusShell),
    // Only the label case carries: the display face doesn't, because a web font
    // isn't there to load and the fallback stack would land somewhere arbitrary.
    labelCase: style.headings?.["--h2-case"] ?? "none",
    labelTracking: style.headings?.["--h2-tracking"] ?? "normal",
  };
}

/** Join class fragments, dropping the empty ones. A style that clears a slot
 *  must not leave a double space behind — the whole no-op proof is a string
 *  comparison against markup that never had one. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
