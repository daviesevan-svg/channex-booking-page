// Move a hotel's chosen accent as little as possible while keeping it legible.
//
// The five named themes ship accents we picked and checked. A custom colour is
// whatever the hotel typed, and it has two jobs: it fills buttons (which carry
// text) and it IS text (links, the eyebrow) on the page background. Both have to
// clear 4.5:1.
//
// Two rules, and the order matters:
//
//  1. CHOOSE THE BUTTON'S TEXT COLOUR, don't assume it. White on #64c494 is
//     2.13:1; the same green under our ink is 7.12:1. Fixing the foreground to
//     white is what used to force a light brand colour to be darkened at all —
//     it turned a legible colour into a different colour for no reason.
//  2. Only then move the lightness, and move it AWAY from the page: darker on a
//     light page, lighter on a dark one. Hue and chroma never change.
//
// The previous version darkened on a binary search that assumed both constraints
// improve together as the colour darkens. That is true on a light page and false
// on a dark one, where they pull in opposite directions: no lightness satisfied
// both, and the search returned its lower bound — which it never tested and
// which was black. A hotel on a dark background got a black button whatever they
// typed. #64c494 on #3d405b already scored 4.74:1 and needed no correction at
// all. So this scans instead, and when nothing can pass it returns the best
// candidate it actually measured rather than an assumption.

import { contrast, fromOklab, hex, INK, luminance, parseHex, TARGET, toOklab, WHITE, type RGB } from "./color";

export type AccentColors = {
  /** The accent to paint with — the input itself whenever it already works. */
  accent: string;
  /** What to write ON the accent: white or ink, whichever is legible. */
  onAccent: string;
  /** The hover state of a filled button: one step further from the page. */
  deep: string;
};

/** How readable `c` is under its best foreground, and as text on the hardest of
 *  `bgs`. A candidate is only usable when both clear the bar. */
function score(c: RGB, bgs: RGB[]) {
  const onWhite = contrast(WHITE, c);
  const onInk = contrast(INK, c);
  const text = Math.max(onWhite, onInk);
  return { text, page: Math.min(...bgs.map((bg) => contrast(c, bg))), onAccent: onWhite >= onInk ? WHITE : INK };
}

/**
 * The accent to render, the colour to write on it, and its hover step.
 *
 * Returns the hotel's colour untouched whenever it already clears both bars —
 * which, once the button's foreground is chosen rather than assumed, is most
 * brand colours. Otherwise the lightness is moved away from the page in 0.005
 * steps and the nearest passing value wins, so the smallest change that works is
 * the one shipped.
 *
 * Not a binary search: "passes" is not monotonic in lightness once the page can
 * be dark, and assuming it was is what returned black. A 201-step scan over one
 * dimension is cheap, and it can report honestly that nothing passed.
 *
 * A malformed accent is returned as-is with white on it — the caller passes
 * admin-entered values, and a typo should render as before rather than throw.
 */
export function accentColors(accent: string, pageBg: string, ...alsoOn: string[]): AccentColors {
  const rgb = parseHex(accent);
  const page = parseHex(pageBg) ?? WHITE;
  // Every background this colour is text on, not just the page — which of them
  // is hardest flips with the theme: a dark accent has MORE contrast on a white
  // card than on a cream page, a light one has less on a lifted dark card than
  // on the page behind it. Checking only the page left "See details" at 3.86:1
  // on a dark theme's cards.
  const bgs = [page, ...alsoOn.map((b) => parseHex(b)).filter((c): c is RGB => !!c)];
  if (!rgb) return { accent, onAccent: "#ffffff", deep: accent };

  const finish = (c: RGB): AccentColors => {
    const { onAccent } = score(c, bgs);
    return {
      accent: hex(c),
      onAccent: hex(onAccent),
      // Hover moves away from the page, so it reads as "more" on either kind of
      // background. Darkening on a dark page made the button recede instead.
      deep: hex(stepLightness(c, luminance(page) > luminance(c) ? -0.08 : 0.08)),
    };
  };

  const first = score(rgb, bgs);
  if (first.text >= TARGET && first.page >= TARGET) return finish(rgb);

  const [L0, A, B] = toOklab(rgb);
  // The WHOLE range, both directions. The constraints already encode which way
  // is helpful — a colour cannot become more readable on a light page by getting
  // lighter — and scanning only the "obvious" side is what leaves a near-black
  // accent on a dark-but-not-black page with nowhere to go. Nearest-passing
  // wins, so the shipped colour is still the smallest change that works.
  let best: { c: RGB; worst: number } | null = null;
  let nearest: { c: RGB; distance: number } | null = null;
  for (let i = 0; i <= 200; i++) {
    const L = i / 200;
    const c = fromOklab([L, A, B]);
    const { text, page: onBg } = score(c, bgs);
    const worst = Math.min(text, onBg);
    if (!best || worst > best.worst) best = { c, worst };
    if (text >= TARGET && onBg >= TARGET) {
      const distance = Math.abs(L - L0);
      if (!nearest || distance < nearest.distance) nearest = { c, distance };
    }
  }
  // Nothing at any lightness passes (a mid-grey page leaves no room on either
  // side): ship the most legible colour we actually measured.
  return finish(nearest?.c ?? best?.c ?? rgb);
}

function stepLightness(rgb: RGB, by: number): RGB {
  const [L, A, B] = toOklab(rgb);
  return fromOklab([Math.min(1, Math.max(0, L + by)), A, B]);
}

/** Approximate `color-mix(in oklab, hex pct%, #ffffff)`, for estimating the page
 *  background a custom accent will sit on. Only used to pick a target — the CSS
 *  still emits the real color-mix so the rendered tint is unchanged. */
export function mixWithWhite(hexColor: string, pct: number): string {
  const rgb = parseHex(hexColor);
  if (!rgb) return "#ffffff";
  const f = pct / 100;
  return hex(rgb.map((c) => Math.round(c * f + 255 * (1 - f))) as RGB);
}
