import { describe, expect, it } from "vitest";

import { accentColors } from "./accessible-accent";

// Every assertion here is a contrast ratio, because that is the only thing the
// module is allowed to change a hotel's colour for. Anything it changes without
// a ratio to show for it is a bug — that was the shape of the black-button one.

const LIN = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const px = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h: string) => {
  const [r, g, b] = px(h);
  return 0.2126 * LIN(r / 255) + 0.7152 * LIN(g / 255) + 0.0722 * LIN(b / 255);
};
const contrast = (a: string, b: string) => {
  const [la, lb] = [lum(a), lum(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const LIGHT_PAGE = "#f7f2ec";
/** The background the customer who reported this actually chose. */
const DARK_PAGE = "#3d405b";

describe("accentColors", () => {
  it("leaves a colour that already works completely alone", () => {
    // #64c494 on #3d405b is 4.74:1 as text and 7.12:1 under ink. The old code
    // returned #000000 for exactly this input.
    const c = accentColors("#64c494", DARK_PAGE);
    expect(c.accent).toBe("#64c494");
    expect(contrast(c.accent, DARK_PAGE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.onAccent, c.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("never returns black on a dark page", () => {
    for (const accent of ["#64c494", "#b5651d", "#ff0000", "#ffd400", "#7fd3ff"]) {
      const { accent: out } = accentColors(accent, DARK_PAGE);
      expect(out).not.toBe("#000000");
      expect(lum(out)).toBeGreaterThan(lum(DARK_PAGE));
    }
  });

  it("picks ink under a light accent and white under a dark one", () => {
    // On the dark page a light accent is what passes, so it keeps its lightness
    // and takes ink. On the light page the same colour has to darken to be
    // readable as link text, and white is then the legible foreground — the
    // foreground follows the colour we end up with, not the one typed.
    expect(accentColors("#ffd400", DARK_PAGE).onAccent).toBe("#2a2521");
    expect(accentColors("#1d4ed8", LIGHT_PAGE).onAccent).toBe("#ffffff");
  });

  it("keeps both bars on every named-theme accent and a spread of brand colours", () => {
    const accents = ["#b5651d", "#64c494", "#ffd400", "#ff0000", "#1d4ed8", "#7fd3ff", "#111111"];
    for (const page of [LIGHT_PAGE, DARK_PAGE, "#ffffff", "#101014"]) {
      for (const accent of accents) {
        const c = accentColors(accent, page);
        expect(contrast(c.onAccent, c.accent), `${accent} on ${page}: button`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.accent, page), `${accent} on ${page}: as text`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("moves lightness away from the page, and hover further still", () => {
    const light = accentColors("#7fd3ff", LIGHT_PAGE);
    expect(lum(light.accent)).toBeLessThan(lum("#7fd3ff"));
    expect(lum(light.deep)).toBeLessThan(lum(light.accent));

    const dark = accentColors("#1d4ed8", DARK_PAGE);
    expect(lum(dark.accent)).toBeGreaterThan(lum("#1d4ed8"));
    // On a dark page the hover state has to get brighter, not darker.
    expect(lum(dark.deep)).toBeGreaterThan(lum(dark.accent));
  });

  it("changes the hue as little as it can — only lightness moves", () => {
    const { accent } = accentColors("#7fd3ff", LIGHT_PAGE);
    const [r, g, b] = px(accent);
    expect(b).toBeGreaterThan(r); // still blue
    expect(g).toBeGreaterThan(r);
  });

  it("returns a malformed value untouched rather than throwing", () => {
    expect(accentColors("not a colour", LIGHT_PAGE)).toEqual({
      accent: "not a colour",
      onAccent: "#ffffff",
      deep: "not a colour",
    });
  });
});
