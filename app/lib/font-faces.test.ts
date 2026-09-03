import { describe, expect, it } from "vitest";

import { FONT_PAIRS } from "./content";
import { FONT_FACE_CSS } from "./font-faces";

// The failure this guards against is silent and total: add a pair to
// FONT_PAIRS, forget to re-run scripts/fetch-fonts.mjs, and every property on
// that pair renders in a system font with nothing in the console. The second
// test guards the point of the exercise — a URL that slips back to Google is
// invisible on a developer's machine and is the exposure itself in Germany.

describe("mirrored font faces", () => {
  it("has faces for every pair a property can choose", () => {
    for (const pair of FONT_PAIRS) {
      expect(FONT_FACE_CSS[pair.id], `${pair.id} — re-run scripts/fetch-fonts.mjs`).toBeTruthy();
    }
  });

  it("serves every file from our own origin", () => {
    for (const [id, css] of Object.entries(FONT_FACE_CSS)) {
      expect(css, id).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      for (const [, url] of css.matchAll(/url\(([^)]+)\)/g)) {
        expect(url, id).toMatch(/^\/fonts\/[\w-]+\.woff2$/);
      }
    }
  });

  it("keeps the unicode-range subsetting — without it every guest downloads every script", () => {
    for (const [id, css] of Object.entries(FONT_FACE_CSS)) {
      expect(css.match(/unicode-range:/g)?.length ?? 0, id).toBe(css.match(/@font-face/g)?.length ?? 0);
    }
  });
});
