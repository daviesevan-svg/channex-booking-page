import { describe, expect, it } from "vitest";

import {
  applyHtmlSecurityHeaders,
  documentContentSecurityPolicy,
  frameAncestorsForPath,
  htmlSecurityHeaders,
  type PartnerFraming,
} from "./html-security-headers";

function cspMapWith(pathname: string, partner: PartnerFraming): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of documentContentSecurityPolicy(pathname, partner).split("; ")) {
    const i = part.indexOf(" ");
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const cspMap = (pathname: string) => cspMapWith(pathname, {});

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

  it("allows Maps and inline hydration without Stripe/Viva frame-src", () => {
    const csp = cspMap("/hotel");
    expect(csp["script-src"]).toContain("'unsafe-inline'");
    expect(csp["script-src"]).toContain("https://maps.googleapis.com");
    expect(csp["script-src"]).not.toContain("js.stripe.com");
    expect(csp["img-src"]).toContain("https:");
    expect(csp["frame-src"]).toBe("'self'");
    expect(csp["frame-src"]).not.toContain("stripe");
    expect(csp["frame-src"]).not.toContain("viva");
  });

  // The typefaces are mirrored into public/fonts/ and served from 'self'. This
  // asserts the policy that keeps it that way: if someone re-adds a Google font
  // host, the browser would happily fetch from it again and every German guest's
  // IP would go back to Google. CSP is the only mechanism that fails loudly.
  it("gives fonts no route back to Google", () => {
    const csp = cspMap("/hotel");
    expect(csp["font-src"]).toBe("'self' data:");
    expect(csp["style-src"]).not.toContain("fonts.googleapis.com");
    expect(csp["style-src"]).not.toContain("fonts.gstatic.com");
    expect(csp["default-src"]).toBe("'self'");
  });

  it("lets Chrome follow the checkout/Connect POST→302 onto Stripe and Viva", () => {
    const form = cspMap("/hotel/checkout")["form-action"];
    expect(form).toContain("'self'");
    expect(form).toContain("https://*.stripe.com");
    expect(form).toContain("https://*.vivapayments.com");
  });
});

describe("partner design preview (the one cross-origin framing pair)", () => {
  const partner = { frames: "https://book.theirpms.com", framedBy: "https://admin.theirpms.com" };

  it("lets a partner admin document embed that partner's guest host", () => {
    const csp = documentContentSecurityPolicy("/admin/website/sections", partner);
    expect(csp).toContain("frame-src 'self' https://book.theirpms.com");
    // Still unframeable itself: the widening is one-directional per document.
    expect(csp).toContain("frame-ancestors 'none'");
    expect(htmlSecurityHeaders("/admin/website/sections", partner)["X-Frame-Options"]).toBe("DENY");
  });

  it("lets that partner's admin host frame a previewed guest document", () => {
    const h = htmlSecurityHeaders("/spilmanhotel", partner);
    expect(h["Content-Security-Policy"]).toContain(
      "frame-ancestors 'self' https://admin.theirpms.com",
    );
    // X-Frame-Options has no allow-list value, so SAMEORIGIN would block the
    // frame whatever CSP said — the same reason /embed omits it.
    expect(h["X-Frame-Options"]).toBeUndefined();
    // A guest page may still not embed anything cross-origin.
    expect(cspMapWith("/spilmanhotel", partner)["frame-src"]).toBe("'self'");
  });

  it("changes nothing when the caller finds no partner (our own hosts)", () => {
    expect(htmlSecurityHeaders("/spilmanhotel")).toEqual(htmlSecurityHeaders("/spilmanhotel", {}));
    expect(cspMap("/admin/team")["frame-src"]).toBe("'self'");
    expect(cspMap("/spilmanhotel")["frame-ancestors"]).toBe("'self'");
  });

  it("never widens the embed widget, which is already framed by anyone", () => {
    expect(cspMapWith("/embed/spilmanhotel", partner)["frame-ancestors"]).toBe("*");
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
