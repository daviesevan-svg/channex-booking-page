import { describe, expect, it } from "vitest";

import { CUSTOM_CSS_MAX, checkCustomCss, customCssVersion, sanitizeCustomCss } from "./custom-css";

describe("sanitizeCustomCss", () => {
  it("leaves an ordinary stylesheet alone", () => {
    const css = `.ui-btn-primary { background: #faa26f; color: #07595b; border-radius: 9999px; }
[data-style] { --text-body-lg: 18px; font-weight: 500; }`;
    expect(sanitizeCustomCss(css)).toBe(css);
  });

  it("cannot close the style element or open a tag", () => {
    const out = sanitizeCustomCss(`a{color:red}</style><script>alert(1)</script><style>`);
    expect(out).not.toContain("<");
    expect(out).toContain("\\3c /style>");
  });

  it("escapes a legitimate < inside a string instead of dropping it", () => {
    expect(sanitizeCustomCss(`.x::after { content: "<" }`)).toBe(`.x::after { content: "\\3c " }`);
  });

  it("drops @import rules but keeps everything around them", () => {
    const out = sanitizeCustomCss(
      `@import url("https://fonts.googleapis.com/css2?family=Montserrat");\n@IMPORT 'x.css' screen;\n.ui-card{--color-surface:#07595b}`,
    );
    expect(out).toBe(`.ui-card{--color-surface:#07595b}`);
  });

  it("is idempotent", () => {
    const once = sanitizeCustomCss(`</style>@import "a";.a{}`);
    expect(sanitizeCustomCss(once)).toBe(once);
  });
});

describe("checkCustomCss", () => {
  it("treats null and undefined as clearing the sheet", () => {
    expect(checkCustomCss(null)).toEqual({ ok: true, css: "" });
    expect(checkCustomCss(undefined)).toEqual({ ok: true, css: "" });
  });

  it("normalises line endings and trims", () => {
    expect(checkCustomCss("  .a{}\r\n.b{}\r\n ")).toEqual({ ok: true, css: ".a{}\n.b{}" });
  });

  it("rejects non-strings and over-long sheets with a reason", () => {
    expect(checkCustomCss(42)).toMatchObject({ ok: false });
    const long = "x".repeat(CUSTOM_CSS_MAX + 1);
    const res = checkCustomCss(long);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain(String(CUSTOM_CSS_MAX));
    expect(checkCustomCss("x".repeat(CUSTOM_CSS_MAX)).ok).toBe(true);
  });
});

describe("customCssVersion", () => {
  it("changes when the sheet changes, even at equal length", () => {
    expect(customCssVersion("")).toBe("0");
    expect(customCssVersion(undefined)).toBe("0");
    expect(customCssVersion(".a{color:red}")).not.toBe(customCssVersion(".a{color:rad}"));
    expect(customCssVersion(".a{}")).toBe(customCssVersion(".a{}"));
  });
});
