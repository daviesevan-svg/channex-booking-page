// Darken a hotel's chosen accent just enough to be legible.
//
// The five named themes ship accents we picked and checked. A custom colour is
// whatever the hotel typed, and plenty of brand colours are too light to carry
// white text or to be read as a link: Spilman's #b5651d gives 4.34:1 under white
// and 3.98:1 on the page, against a 4.5 requirement, which is exactly what the
// audit flagged on "Search rooms" and the eyebrow.
//
// So: keep the hue and the chroma, and lower the lightness by the smallest amount
// that clears the bar. A colour that already passes is returned untouched. The
// hotel's brand is respected as far as legibility allows and no further — the
// alternative is shipping a known WCAG failure on every custom-coloured property.

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
/** WCAG AA for normal-size text. */
const TARGET = 4.5;

/**
 * `accent` darkened until white text on it AND it as text on `pageBg` both reach
 * 4.5:1. Both improve monotonically as it darkens, so one search satisfies both.
 *
 * Returns the input unchanged when it isn't a hex colour — the caller passes
 * admin-entered values, and a malformed one should render as before rather than
 * throw.
 */
export function accessibleAccent(accent: string, pageBg: string): string {
  const rgb = parseHex(accent);
  const bg = parseHex(pageBg) ?? WHITE;
  if (!rgb) return accent;
  if (contrast(WHITE, rgb) >= TARGET && contrast(rgb, bg) >= TARGET) return hex(rgb);

  const [, A, B] = toOklab(rgb);
  let lo = 0;
  let hi = toOklab(rgb)[0];
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const candidate = fromOklab([mid, A, B]);
    if (contrast(WHITE, candidate) >= TARGET && contrast(candidate, bg) >= TARGET) lo = mid;
    else hi = mid;
  }
  return hex(fromOklab([lo, A, B]));
}

/** One step darker again, for the hover state of a filled button. */
export function darkerAccent(accent: string): string {
  const rgb = parseHex(accent);
  if (!rgb) return accent;
  const [L, A, B] = toOklab(rgb);
  return hex(fromOklab([Math.max(0, L - 0.08), A, B]));
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
