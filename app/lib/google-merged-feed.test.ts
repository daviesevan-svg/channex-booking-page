import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: () => {} }));

const { normalizeImageTypes } = await import("./google-merged-feed.server");

// Google's local_feed.xsd only accepts ad|coupon|menu|photo for <image type>;
// Channex's partner feed emits its own categories (room, exterior).
describe("normalizeImageTypes", () => {
  it("rewrites types outside the schema enumeration to photo", () => {
    const xml =
      '<image type="room" url="a"/><image type="exterior" url="b"/><image type="" url="c"/>';
    expect(normalizeImageTypes(xml)).toBe(
      '<image type="photo" url="a"/><image type="photo" url="b"/><image type="photo" url="c"/>',
    );
  });

  it("leaves valid types untouched", () => {
    const xml =
      '<image type="ad" url="a"/><image type="coupon" url="b"/><image type="menu" url="c"/><image type="photo" url="d"/>';
    expect(normalizeImageTypes(xml)).toBe(xml);
  });

  it("only touches <image> elements", () => {
    const xml = '<phone type="main">1</phone><image type="room" url="a"/>';
    expect(normalizeImageTypes(xml)).toBe('<phone type="main">1</phone><image type="photo" url="a"/>');
  });

  it("repairs the real partner feed shape", () => {
    const xml = '<image type="room" url="https://images.channex.io/x"><link>l</link></image>';
    expect(normalizeImageTypes(xml)).toContain('<image type="photo" url="https://images.channex.io/x">');
  });
});
