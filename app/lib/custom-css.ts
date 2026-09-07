// Per-property custom CSS, for the guest pages.
//
// Every guest surface reads its colours, corners and type sizes from CSS
// variables on the wrapper element (app.css, site-style.ts), and the style
// slots carry stable `ui-*` hook classes. That makes a stylesheet the property
// writes itself the whole of the "give me a button colour / a card colour / a
// radius / a logo size" request, without a picker for each in the admin. The
// vocabulary is documented in docs/custom-css.md.
//
// What this module guards against is the stylesheet leaving the style element,
// not the property styling its own pages badly: the same admin already controls
// every word and picture on those pages. So `<` is escaped (no `</style>`, no
// markup), `@import` is dropped (the CSP blocks external stylesheets anyway, and
// a rule that can never load is better rejected than kept), and the length is
// capped so the property record and every guest HTML response stay small.

export const CUSTOM_CSS_MAX = 20_000;

export type CustomCssCheck = { ok: true; css: string } | { ok: false; reason: string };

/**
 * Validate and normalise a stylesheet the operator pasted. Returns the text to
 * store — or the reason it can't be. Only the length is a rejection: the other
 * two rules rewrite, because an AI-written sheet with a stray `@import` should
 * still save with the rest of its rules intact.
 */
export function checkCustomCss(raw: unknown): CustomCssCheck {
  if (raw === null || raw === undefined) return { ok: true, css: "" };
  if (typeof raw !== "string") return { ok: false, reason: "custom_css must be a string." };
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length > CUSTOM_CSS_MAX) {
    return { ok: false, reason: `custom_css is ${text.length} characters; the limit is ${CUSTOM_CSS_MAX}.` };
  }
  return { ok: true, css: sanitizeCustomCss(text) };
}

/**
 * The text that goes inside the style element. Idempotent, so stored values
 * from before a rule change are re-sanitised harmlessly on render.
 *
 *  - `<` becomes the CSS escape `\3c ` — valid inside strings and url() where
 *    it might legitimately appear, and a no-op elsewhere since `<` is not CSS.
 *    With no `<` left there is no way to close the style element or open a tag.
 *  - `@import …;` rules are removed. A url() on `background-image` is still
 *    allowed: img-src permits https, and the property already uploads pictures.
 */
export function sanitizeCustomCss(css: string): string {
  return css
    .replace(/@import\b[^;]*;?/gi, "")
    .replace(/</g, "\\3c ")
    .trim();
}

/** Short stable digest, for cache-busting a preview iframe when the sheet changes. */
export function customCssVersion(css: string | undefined | null): string {
  if (!css) return "0";
  let h = 5381;
  for (let i = 0; i < css.length; i++) h = ((h << 5) + h + css.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
