import { describe, expect, it } from "vitest";

import { HSTS_VALUE, httpsRedirect, withHsts } from "./https-redirect";

const APP = "https://book.example.com";

describe("httpsRedirect", () => {
  it("sends a plain-HTTP GET to its https twin, path and query intact", () => {
    const res = httpsRedirect(new Request("http://book.example.com/spilmanhotel?checkin=2026-09-14"), APP);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe("https://book.example.com/spilmanhotel?checkin=2026-09-14");
  });

  it("covers custom hotel domains, not just the canonical host", () => {
    const res = httpsRedirect(new Request("http://www.spilmanhotel.co.uk/rooms"), APP);
    expect(res?.headers.get("Location")).toBe("https://www.spilmanhotel.co.uk/rooms");
  });

  it("uses 308 for non-GET so the method survives", () => {
    const res = httpsRedirect(new Request("http://book.example.com/admin/login", { method: "POST", body: "x" }), APP);
    expect(res?.status).toBe(308);
  });

  it("leaves https requests alone", () => {
    expect(httpsRedirect(new Request("https://book.example.com/"), APP)).toBeNull();
  });

  it("is off for local development (APP_URL is http) and for localhost", () => {
    expect(httpsRedirect(new Request("http://localhost:5173/"), "http://localhost:5173")).toBeNull();
    expect(httpsRedirect(new Request("http://localhost:5173/"), APP)).toBeNull();
    expect(httpsRedirect(new Request("http://127.0.0.1:8787/"), APP)).toBeNull();
  });
});

describe("withHsts", () => {
  it("stamps HSTS on https responses, including redirects with immutable headers", () => {
    const req = new Request("https://book.example.com/");
    expect(withHsts(new Response("ok"), req, APP).headers.get("Strict-Transport-Security")).toBe(HSTS_VALUE);
    const redirected = withHsts(Response.redirect("https://book.example.com/x", 301), req, APP);
    expect(redirected.status).toBe(301);
    expect(redirected.headers.get("Strict-Transport-Security")).toBe(HSTS_VALUE);
  });

  it("does not stamp plain-HTTP responses (the header would be ignored anyway) or dev", () => {
    const res = new Response("ok");
    expect(withHsts(res, new Request("http://book.example.com/"), APP)).toBe(res);
    expect(withHsts(res, new Request("https://localhost/"), "http://localhost:5173")).toBe(res);
  });

  it("never sets includeSubDomains", () => {
    expect(HSTS_VALUE).not.toMatch(/includeSubDomains/i);
  });
});
