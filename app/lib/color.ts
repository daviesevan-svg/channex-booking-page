// Colour maths shared by everything that has to prove a contrast ratio: the
// accent solver (accessible-accent.ts) and the dark neutral palette
// (theme-neutrals.ts).
//
// sRGB in, sRGB out, with OKLCH in the middle — lightness moves without dragging
// hue and chroma with it, which is what lets a hotel's colour stay recognisably
// theirs after we have made it legible.

export type RGB = [number, number, number];

const SRGB = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const LINEAR = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

export const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * LINEAR(r / 255) + 0.7152 * LINEAR(g / 255) + 0.0722 * LINEAR(b / 255);

export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function toOklab([r, g, b]: [number, number, number]): [number, number, number] {
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

export function fromOklab([L, A, B]: [number, number, number]): [number, number, number] {
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

export const hex = ([r, g, b]: [number, number, number]) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

export const WHITE: RGB = [255, 255, 255];
/** The light theme's `--color-ink`. */
export const INK: RGB = [0x2a, 0x25, 0x21];
/** WCAG AA for normal-size text. */
export const TARGET = 4.5;

/** `a` mixed towards `b`; `t` is how far, 0 = `a`, 1 = `b`. Plain sRGB, which is
 *  what `color-mix(in oklab, …)` approximates closely enough for neutrals. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return a.map((c, i) => Math.round(c + (b[i] - c) * t)) as RGB;
}
