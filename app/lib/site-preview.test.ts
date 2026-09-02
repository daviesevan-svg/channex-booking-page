import { describe, expect, it, vi } from "vitest";

// The design preview's permission travels in the URL because it has to cross a
// host boundary the admin session cannot. That makes the token itself the whole
// gate, so: it must not be forgeable, it must not carry across properties, and
// an expired one must simply stop working.

vi.mock("cloudflare:workers", () => ({
  env: { SESSION_SECRET: "test-secret" },
  waitUntil: () => {},
}));

const { createPreviewToken, verifyPreviewToken } = await import("./site-preview.server");

describe("preview tokens", () => {
  it("verifies a token it just minted, for that property", async () => {
    expect(await verifyPreviewToken(await createPreviewToken("p1"), "p1")).toBe(true);
  });

  it("refuses a token minted for another property", async () => {
    // Otherwise one hotel's operator could restyle another hotel's public page.
    expect(await verifyPreviewToken(await createPreviewToken("p1"), "p2")).toBe(false);
  });

  it("refuses a tampered signature or expiry", async () => {
    const token = await createPreviewToken("p1");
    const [exp, sig] = token.split(".");
    expect(await verifyPreviewToken(`${exp}.${"0".repeat(sig.length)}`, "p1")).toBe(false);
    // Pushing the expiry out has to invalidate the signature, not extend the token.
    expect(await verifyPreviewToken(`${Number(exp) + 60_000}.${sig}`, "p1")).toBe(false);
  });

  it("refuses an expired token", async () => {
    const token = await createPreviewToken("p1");
    vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
    expect(await verifyPreviewToken(token, "p1")).toBe(false);
    vi.useRealTimers();
  });

  it("refuses junk rather than throwing", async () => {
    for (const junk of ["", ".", "abc", "abc.def", "1"]) {
      expect(await verifyPreviewToken(junk, "p1")).toBe(false);
    }
  });
});
