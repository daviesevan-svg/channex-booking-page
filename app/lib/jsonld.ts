// Client-safe helper for embedding JSON-LD in a <script type="application/ld+json">.
//
// JSON.stringify does NOT escape "<", so a string value containing "</script>"
// (e.g. an operator-edited hotel name or room title) would close the tag early
// and inject markup into the page — stored XSS. We re-emit "<" as the JSON
// escape sequence backslash-u003c: the parsed JSON is identical, but the raw
// text can no longer form a closing tag. U+2028/U+2029 get the same treatment
// (valid in JSON, line terminators in JS) — via fromCharCode because the raw
// characters must never appear in source either.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

export function jsonLdHtml(o: unknown): string {
  return JSON.stringify(o)
    .replace(/</g, "\\u003c")
    .split(LS).join("\\u2028")
    .split(PS).join("\\u2029");
}
