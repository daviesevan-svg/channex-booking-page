// The neutral palette for a hotel that chose a dark page colour.
//
// The light palette is warm greys picked against a cream page, and every one of
// them is unreadable on a dark one: our body ink scores 1.50:1 on #3d405b. A
// hotel could already SET that background — nothing stopped them — so the page
// they got was dark with dark text on it. This is the other half of the setting.
//
// Derived from the page rather than a second fixed palette, because the page can
// be any colour. Surfaces and hairlines are the page lifted towards white by a
// fixed amount, so a card still reads as raised out of the page and keeps the
// hotel's hue; the TEXT steps are solved for a contrast ratio instead of a mix
// percentage, so the ramp holds whether the page is near-black or merely dark.
//
// Solved against the LIGHTEST surface that carries text — a chip, not the page.
// Every surface here is the page lifted towards white, so the lightest one is
// the hardest for light text; clearing it clears all of them. Solving against
// the card alone left the footer, which sits on `surface-alt`, at 4.29:1.
//
// There is no admin switch. A background light enough to read our ink on keeps
// the light palette; one that isn't gets this. Asking a hotel to pick "dark
// mode" as well as a dark colour is asking them to say the same thing twice, and
// the two settings could then disagree.

import { accentColors } from "./accessible-accent";
import { contrast, hex, INK, mix, parseHex, TARGET, WHITE, type RGB } from "./color";

/** Every neutral the guest surfaces read, as CSS custom-property names. */
export type NeutralTokens = Record<string, string>;

/** Contrast each text step aims for on the card surface. The light palette's own
 *  ramp, which was tuned to 7.01 / 5.86 / 4.91 / 4.56 — same order, same
 *  intent, so a page that goes dark keeps its hierarchy. */
const TEXT_STEPS: [name: string, target: number][] = [
  ["--color-ink", 12],
  ["--color-secondary", 7],
  ["--color-muted", 5.9],
  ["--color-muted-2", 5.2],
  ["--color-faint", 4.8],
  ["--color-faint-2", 4.8],
];

/** Structural tokens that TEXT sits on. The lightest of these is what the text
 *  ramp has to clear. */
const TEXT_BEARING = new Set([
  "--color-surface",
  "--color-surface-alt",
  "--color-chip",
  "--color-field-hover",
]);

/** How far each structural token is lifted off the page, towards white. */
const STRUCTURE: [name: string, lift: number][] = [
  ["--color-surface", 0.07],
  ["--color-surface-alt", 0.11],
  ["--color-chip", 0.12],
  ["--color-field-hover", 0.1],
  ["--color-divider", 0.16],
  ["--color-line", 0.2],
  ["--color-nav-border", 0.22],
  ["--color-line-alt", 0.28],
  ["--color-chip-border", 0.28],
  ["--color-disabled-day", 0.42],
];

/** True when a page is dark enough that white text reads better than our ink —
 *  the whole trigger, and the only thing the hotel has to decide. */
export function pageIsDark(page: string): boolean {
  const rgb = parseHex(page);
  if (!rgb) return false;
  return contrast(WHITE, rgb) > contrast(INK, rgb);
}

/** The lightest mix towards white that reaches `target` against `on` — lightest,
 *  so the ramp stays as close to the page's own colour as the ratio allows.
 *  Contrast rises monotonically as light text lifts off a dark surface, so a
 *  binary search is honest here; it is clamped at white, which is the most
 *  contrast available. */
function textAt(page: RGB, on: RGB, target: number): RGB {
  if (contrast(WHITE, on) < target) return WHITE; // even white can't reach it
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    if (contrast(mix(page, WHITE, t), on) >= target) hi = t;
    else lo = t;
  }
  return mix(page, WHITE, hi);
}

/**
 * The token overrides to put on the guest wrapper for a dark `page`, or null
 * when the page is light and the built-in palette already applies.
 *
 * The keys are the same `--color-*` names the utilities compile to, so this
 * restyles every guest surface at once without touching a call site — which
 * only works because those tokens live in a plain `@theme` block. In
 * `@theme inline` Tailwind bakes the value into the utility and an override here
 * would do exactly nothing.
 */
export function darkNeutrals(page: string): NeutralTokens | null {
  const rgb = parseHex(page);
  if (!rgb || !pageIsDark(page)) return null;

  const tokens: NeutralTokens = { "--color-page": hex(rgb) };
  for (const [name, lift] of STRUCTURE) tokens[name] = hex(mix(rgb, WHITE, lift));
  const hardest = mix(rgb, WHITE, Math.max(...STRUCTURE.filter(([n]) => TEXT_BEARING.has(n)).map(([, l]) => l)));
  for (const [name, target] of TEXT_STEPS) tokens[name] = hex(textAt(rgb, hardest, target));
  return tokens;
}

/**
 * The soft accent tints for a dark page.
 *
 * The light theme mixes the accent into WHITE, which on a dark page produces a
 * pale block in the middle of the design — and one the (now light) body text
 * cannot be read on. Mixing into the page instead keeps them as tints of the
 * surface they sit on.
 *
 * How far to mix is solved, not chosen: these tints are backgrounds for real
 * text — body copy on the confirmation panels, `--accent-deep` on the offer
 * pill — so the tint stops at the last step where that text still clears AA. A
 * flat 22% left "15% off" at 4.28:1.
 */
export function darkAccentTints(
  page: string,
  accent: string,
  /** The colours that have to stay readable ON the tints. */
  foregrounds: string[],
): { soft: string; softStrong: string } | null {
  const p = parseHex(page);
  const a = parseHex(accent);
  const fg = foregrounds.map(parseHex).filter((c): c is RGB => !!c);
  if (!p || !a || !fg.length || !pageIsDark(page)) return null;
  const readable = (t: number) => fg.every((f) => contrast(f, mix(p, a, t)) >= TARGET);
  // Contrast falls monotonically as a dark page is tinted towards a lighter
  // accent, so the largest readable mix is a binary search away.
  const largestReadable = (cap: number) => {
    if (readable(cap)) return cap;
    let lo = 0;
    let hi = cap;
    for (let i = 0; i < 20; i++) {
      const t = (lo + hi) / 2;
      if (readable(t)) lo = t;
      else hi = t;
    }
    return lo;
  };
  return { soft: hex(mix(p, a, largestReadable(0.22))), softStrong: hex(mix(p, a, largestReadable(0.4))) };
}

/** The light theme's status hues, the colours the tokens carry today. Dark
 *  values are derived FROM these so a family keeps its meaning: green still
 *  reads as green, it just stops being a pastel block on a dark page. */
const STATUS: [family: string, hue: string][] = [
  ["success", "#3f7a52"],
  ["danger", "#c0392b"],
  ["notice", "#8a4a2f"],
  ["caution", "#b08968"],
  ["info", "#6b4f8a"],
];

/**
 * Status colours for a dark page: the same hues, lifted until they are legible,
 * with their soft panels mixed into the page rather than into white.
 *
 * Reuses the accent solver, because the question is identical — keep this hue,
 * make it readable here — and it is already the thing that knows how to answer
 * it without turning a colour into a different colour.
 */
export function darkStatus(page: string, ink: string, card: string): NeutralTokens | null {
  const p = parseHex(page);
  const fg = parseHex(ink);
  if (!p || !fg || !pageIsDark(page)) return null;
  const tokens: NeutralTokens = {};
  for (const [family, hue] of STATUS) {
    // Solved against every surface it is text on: its own panel, the page, and
    // the CARD — `text-danger` is a "Remove" link on a plain card as often as it
    // is a word inside a red panel, and the card is the lightest of the three.
    const soft = mix(p, parseHex(hue)!, 0.18);
    const { accent } = accentColors(hue, page, hex(soft), card);
    tokens[`--color-${family}`] = accent;
    if (family === "caution") continue; // text only — no panel, no hairline
    tokens[`--color-${family}-soft`] = hex(soft);
    if (family === "success" || family === "danger" || family === "notice") {
      tokens[`--color-${family}-line`] = hex(mix(p, parseHex(accent)!, 0.42));
    }
  }
  return tokens;
}
