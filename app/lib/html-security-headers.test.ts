import { describe, expect, it } from "vitest";

import {
  applyHtmlSecurityHeaders,
  documentContentSecurityPolicy,
  frameAncestorsForPath,
  htmlSecurityHeaders,
} from "./html-security-headers";

function cspMap(pathname: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of documentContentSecurityPolicy(pathname).split("; ")) {
    const i = part.indexOf(" ");
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

describe("frameAncestorsForPath", () => {
  it("denies framing on admin (Connect / team invite clickjacking)", () => {
    expect(frameAncestorsForPath("/admin")).toBe("none");
    expect(frameAncestorsForPath("/admin/")).toBe("none");
    expect(frameAncestorsForPath("/admin/team")).toBe("none");
    expect(frameAncestorsForPath("/admin/payments")).toBe("none");
    expect(frameAncestorsForPath("/admin/login")).toBe("none");
    expect(frameAncestorsForPath("/Admin/Team")).toBe("none");
  });

  it("allows any ancestor on the hotel embed widget", () => {
    expect(frameAncestorsForPath("/embed/spilmanhotel")).toBe("*");
    expect(frameAncestorsForPath("/embed")).toBe("*");
    expect(frameAncestorsForPath("/embed/")).toBe("*");
  });

  it("keeps guest documents same-origin (admin design preview iframes /{slug})", () => {
    expect(frameAncestorsForPath("/")).toBe("self");
    expect(frameAncestorsForPath("/spilmanhotel")).toBe("self");
    expect(frameAncestorsForPath("/spilmanhotel/checkout")).toBe("self");
    expect(frameAncestorsForPath("/c/islands")).toBe("self");
    expect(frameAncestorsForPath("/viva/return")).toBe("self");
  });

  it("does not treat /administration or /embedder as reserved prefixes", () => {
    expect(frameAncestorsForPath("/administration")).toBe("self");
    expect(frameAncestorsForPath("/embedder")).toBe("self");
  });
});

describe("htmlSecurityHeaders", () => {
  it("always sets nosniff, referrer-policy, and a document CSP", () => {
    for (const path of ["/admin/team", "/embed/p", "/hotel/checkout"]) {
      const h = htmlSecurityHeaders(path);
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["Content-Security-Policy"]).toContain("default-src 'self'");
    }
  });

  it("pairs CSP frame-ancestors with matching X-Frame-Options, omitted on embed", () => {
    expect(htmlSecurityHeaders("/admin/team")["X-Frame-Options"]).toBe("DENY");
    expect(cspMap("/admin/team")["frame-ancestors"]).toBe("'none'");

    expect(htmlSecurityHeaders("/hotel/rooms")["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(cspMap("/hotel/rooms")["frame-ancestors"]).toBe("'self'");

    expect(htmlSecurityHeaders("/embed/p")["X-Frame-Options"]).toBeUndefined();
    expect(cspMap("/embed/p")["frame-ancestors"]).toBe("*");
  });

  it("allows Maps, fonts, and inline hydration without Stripe/Viva frame-src", () => {
    const csp = cspMap("/hotel");
    expect(csp["script-src"]).toContain("'unsafe-inline'");
    expect(csp["script-src"]).toContain("https://maps.googleapis.com");
    expect(csp["script-src"]).not.toContain("js.stripe.com");
    expect(csp["style-src"]).toContain("https://fonts.googleapis.com");
    expect(csp["font-src"]).toContain("https://fonts.gstatic.com");
    expect(csp["img-src"]).toContain("https:");
    expect(csp["frame-src"]).toBe("'self'");
    expect(csp["frame-src"]).not.toContain("stripe");
    expect(csp["frame-src"]).not.toContain("viva");
  });

  it("lets Chrome follow the checkout/Connect POST→302 onto Stripe and Viva", () => {
    const form = cspMap("/hotel/checkout")["form-action"];
    expect(form).toContain("'self'");
    expect(form).toContain("https://*.stripe.com");
    expect(form).toContain("https://*.vivapayments.com");
  });
});

describe("applyHtmlSecurityHeaders", () => {
  it("writes onto an existing Headers object from the request path", () => {
    const headers = new Headers({ "Content-Type": "text/html" });
    applyHtmlSecurityHeaders(headers, new Request("https://book.roompanda.com/admin/team"));
    expect(headers.get("Content-Type")).toBe("text/html");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});
