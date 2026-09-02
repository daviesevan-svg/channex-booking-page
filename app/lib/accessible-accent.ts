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

const SRGB = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const LINEAR = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * LINEAR(r / 255) + 0.7152 * LINEAR(g / 255) + 0.0722 * LINEAR(b / 255);

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const [R, G, B] = [LINEAR(r / 255), LINEAR(g / 255), LINEAR(b / 255)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const clamp = (c: number) => Math.round(Math.min(1, Math.max(0, SRGB(Math.min(1, Math.max(0, c))))) * 255);
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const hex = ([r, g, b]: [number, number, number]) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

const WHITE: [number, number, number] = [255, 255, 255];
/** `--color-ink`, the alternative to white under a filled button. */
const INK: [number, number, number] = [0x2a, 0x25, 0x21];
/** WCAG AA for normal-size text. */
const TARGET = 4.5;

export type AccentColors = {
  /** The accent to paint with — the input itself whenever it already works. */
  accent: string;
  /** What to write ON the accent: white or ink, whichever is legible. */
  onAccent: string;
  /** The hover state of a filled button: one step further from the page. */
  deep: string;
};

/** How readable `c` is under its best foreground, and as text on `bg`. A
 *  candidate is only usable when both clear the bar. */
function score(c: [number, number, number], bg: [number, number, number]) {
  const onWhite = contrast(WHITE, c);
  const onInk = contrast(INK, c);
  const text = Math.max(onWhite, onInk);
  return { text, page: contrast(c, bg), onAccent: onWhite >= onInk ? WHITE : INK };
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
export function accentColors(accent: string, pageBg: string): AccentColors {
  const rgb = parseHex(accent);
  const bg = parseHex(pageBg) ?? WHITE;
  if (!rgb) return { accent, onAccent: "#ffffff", deep: accent };

  const finish = (c: [number, number, number]): AccentColors => {
    const { onAccent } = score(c, bg);
    return {
      accent: hex(c),
      onAccent: hex(onAccent),
      // Hover moves away from the page, so it reads as "more" on either kind of
      // background. Darkening on a dark page made the button recede instead.
      deep: hex(stepLightness(c, luminance(bg) > luminance(c) ? -0.08 : 0.08)),
    };
  };

  const first = score(rgb, bg);
  if (first.text >= TARGET && first.page >= TARGET) return finish(rgb);

  const [L0, A, B] = toOklab(rgb);
  // The WHOLE range, both directions. The constraints already encode which way
  // is helpful — a colour cannot become more readable on a light page by getting
  // lighter — and scanning only the "obvious" side is what leaves a near-black
  // accent on a dark-but-not-black page with nowhere to go. Nearest-passing
  // wins, so the shipped colour is still the smallest change that works.
  let best: { c: [number, number, number]; worst: number } | null = null;
  let nearest: { c: [number, number, number]; distance: number } | null = null;
  for (let i = 0; i <= 200; i++) {
    const L = i / 200;
    const c = fromOklab([L, A, B]);
    const { text, page } = score(c, bg);
    const worst = Math.min(text, page);
    if (!best || worst > best.worst) best = { c, worst };
    if (text >= TARGET && page >= TARGET) {
      const distance = Math.abs(L - L0);
      if (!nearest || distance < nearest.distance) nearest = { c, distance };
    }
  }
  // Nothing at any lightness passes (a mid-grey page leaves no room on either
  // side): ship the most legible colour we actually measured.
  return finish(nearest?.c ?? best?.c ?? rgb);
}

function stepLightness(rgb: [number, number, number], by: number): [number, number, number] {
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
  return hex(rgb.map((c) => Math.round(c * f + 255 * (1 - f))) as [number, number, number]);
}
