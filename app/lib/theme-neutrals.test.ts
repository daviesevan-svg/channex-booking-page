import { describe, expect, it } from "vitest";

import { contrast, parseHex } from "./color";
import { darkNeutrals, darkStatus, pageIsDark } from "./theme-neutrals";

// The palette exists to hold contrast ratios, so that is what is asserted. A
// colour value here would only record what the maths happened to produce.

const ratio = (a: string, b: string) => contrast(parseHex(a)!, parseHex(b)!);

/** The background the customer who reported this actually chose. */
const DARK = "#3d405b";
const PAGES = [DARK, "#000000", "#101014", "#1b3a2f", "#4a1d2b", "#2b2b2b"];
const TEXT = [
  "--color-ink",
  "--color-secondary",
  "--color-muted",
  "--color-muted-2",
  "--color-faint",
  "--color-faint-2",
];

describe("pageIsDark", () => {
  it("is the light palette's own question: does white beat ink here", () => {
    expect(pageIsDark(DARK)).toBe(true);
    expect(pageIsDark("#000000")).toBe(true);
    expect(pageIsDark("#f7f2ec")).toBe(false); // the default page
    expect(pageIsDark("#ffffff")).toBe(false);
    expect(pageIsDark("not a colour")).toBe(false);
  });
});

describe("darkNeutrals", () => {
  it("leaves a light page to the built-in palette", () => {
    expect(darkNeutrals("#f7f2ec")).toBeNull();
    expect(darkNeutrals("#ffffff")).toBeNull();
    expect(darkNeutrals("")).toBeNull();
  });

  it("clears AA for every text step on EVERY surface text can sit on", () => {
    // Not just the card: the footer is `surface-alt` and chips are lighter
    // still, and solving against the card alone left the footer at 4.29:1.
    const surfaces = ["--color-surface", "--color-surface-alt", "--color-chip", "--color-field-hover"];
    for (const page of PAGES) {
      const t = darkNeutrals(page)!;
      for (const step of TEXT) {
        expect(ratio(t[step], page), `${step} on page @ ${page}`).toBeGreaterThanOrEqual(4.5);
        for (const surface of surfaces) {
          expect(ratio(t[step], t[surface]), `${step} on ${surface} @ ${page}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("keeps the ramp in order — ink is the strongest, faint the weakest", () => {
    for (const page of PAGES) {
      const t = darkNeutrals(page)!;
      const ratios = TEXT.map((s) => ratio(t[s], t["--color-surface"]));
      for (let i = 1; i < ratios.length; i++) {
        expect(ratios[i], `${TEXT[i]} @ ${page}`).toBeLessThanOrEqual(ratios[i - 1] + 0.001);
      }
    }
  });

  it("raises cards off the page and keeps hairlines between the two", () => {
    for (const page of PAGES) {
      const t = darkNeutrals(page)!;
      // A card has to be visible as a card, without becoming a light surface
      // that the light palette's text would have suited better.
      expect(ratio(t["--color-surface"], page), `card @ ${page}`).toBeGreaterThan(1.02);
      expect(pageIsDark(t["--color-surface"]), `card still dark @ ${page}`).toBe(true);
      expect(ratio(t["--color-line"], page)).toBeGreaterThan(ratio(t["--color-divider"], page));
    }
  });

  it("stays in the hotel's hue rather than going grey", () => {
    // #1b3a2f is green; its card and its softer text should still lean green.
    // Not `--color-ink`: the top step takes whatever contrast is available, and
    // on a page this dark that is pure white. A dark theme's brightest text
    // being white is normal — the hue lives in everything under it.
    const t = darkNeutrals("#1b3a2f")!;
    for (const key of ["--color-surface", "--color-secondary", "--color-faint"]) {
      const [r, g, b] = parseHex(t[key])!;
      expect(g, key).toBeGreaterThan(r);
      expect(g, key).toBeGreaterThan(b);
    }
  });
});

describe("darkStatus", () => {
  it("keeps every status colour readable on its own panel, the card and the page", () => {
    for (const page of PAGES) {
      const n = darkNeutrals(page)!;
      const t = darkStatus(page, n["--color-ink"], n["--color-surface"])!;
      for (const family of ["success", "danger", "notice", "info"]) {
        const fg = t[`--color-${family}`];
        expect(ratio(fg, t[`--color-${family}-soft`]), `${family} on its panel @ ${page}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(fg, page), `${family} on page @ ${page}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(fg, n["--color-surface"]), `${family} on card @ ${page}`).toBeGreaterThanOrEqual(4.5);
        // The panel is a tint of the page, not a pale block dropped onto it.
        expect(pageIsDark(t[`--color-${family}-soft`]), `${family} panel dark @ ${page}`).toBe(true);
      }
      // Body text has to survive on a status panel too — a cancellation notice
      // is a paragraph on `danger-soft`, not just its heading.
      expect(ratio(n["--color-ink"], t["--color-danger-soft"]), `ink on danger @ ${page}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("stays on the light palette for a light page", () => {
    expect(darkStatus("#f7f2ec", "#2a2521", "#ffffff")).toBeNull();
  });

  it("keeps each family recognisably its own hue", () => {
    const t = darkStatus(DARK, "#ffffff", darkNeutrals(DARK)!["--color-surface"])!;
    const [sr, sg] = parseHex(t["--color-success"])!;
    expect(sg).toBeGreaterThan(sr); // green stays green
    const [dr, dg] = parseHex(t["--color-danger"])!;
    expect(dr).toBeGreaterThan(dg); // red stays red
  });
});
