import { describe, expect, it } from "vitest";

import { dedupeImages, parsePastedImageUrls, pastedUrlError } from "./pasted-image-urls";

describe("parsePastedImageUrls", () => {
  it("accepts absolute https urls", () => {
    const { urls, rejected } = parsePastedImageUrls(
      "https://images.unsplash.com/photo-1?w=1600\n  https://cdn.example.com/room.jpg  ",
    );
    expect(urls).toEqual(["https://images.unsplash.com/photo-1?w=1600", "https://cdn.example.com/room.jpg"]);
    expect(rejected).toEqual([]);
  });

  it("accepts one of our own uploaded image paths, so a photo can be reused", () => {
    const own = "/images/catalog/prop-1/room-1/abc-800x600.jpg";
    expect(parsePastedImageUrls(own).urls).toEqual([own]);
  });

  it("ignores blank lines", () => {
    const { urls, rejected } = parsePastedImageUrls("\n\n  \nhttps://a.example/x.jpg\n\n");
    expect(urls).toEqual(["https://a.example/x.jpg"]);
    expect(rejected).toEqual([]);
  });

  // Every one of these saved silently before, and became a permanently broken
  // photo on the guest page.
  it("refuses what is not a usable image url", () => {
    const { urls, rejected } = parsePastedImageUrls(
      ["not-a-url", "://broken", "data:image/gif;base64,R0lGODlhAQABAAAAACw=", "<script>alert(1)</script>"].join("\n"),
    );
    expect(urls).toEqual([]);
    expect(rejected.map((r) => r.line)).toEqual([
      "not-a-url",
      "://broken",
      "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      "<script>alert(1)</script>",
    ]);
  });

  it("refuses http, which a guest page blocks as mixed content anyway", () => {
    const { urls, rejected } = parsePastedImageUrls("http://old-site.example/room.jpg");
    expect(urls).toEqual([]);
    expect(rejected[0].reason).toBe("must start with https://");
  });

  it("refuses a path traversal dressed up as one of ours", () => {
    expect(parsePastedImageUrls("/images/catalog/../../secret.jpg").urls).toEqual([]);
    // Not a property-upload root, so not a path we recognise.
    expect(parsePastedImageUrls("/images/partners/hotelsoft/logo/x.png").urls).toEqual([]);
  });

  it("keeps the good lines and reports the bad ones together", () => {
    const { urls, rejected } = parsePastedImageUrls("https://a.example/1.jpg\noops\nhttps://a.example/2.jpg");
    expect(urls).toEqual(["https://a.example/1.jpg", "https://a.example/2.jpg"]);
    expect(rejected).toEqual([{ line: "oops", reason: "must be a full https:// url" }]);
  });

  it("collapses a url pasted twice", () => {
    const { urls } = parsePastedImageUrls("https://a.example/1.jpg\nhttps://a.example/1.jpg");
    expect(urls).toEqual(["https://a.example/1.jpg"]);
  });
});

describe("pastedUrlError", () => {
  it("names the offending lines and counts the rest", () => {
    expect(pastedUrlError([{ line: "oops", reason: "must be a full https:// url" }])).toBe(
      'Check the image URLs: "oops" must be a full https:// url.',
    );
    const many = Array.from({ length: 5 }, (_, i) => ({ line: `bad${i}`, reason: "must be a full https:// url" }));
    expect(pastedUrlError(many)).toContain("and 3 more");
  });
});

describe("dedupeImages", () => {
  it("keeps the first occurrence, so kept photos hold their order", () => {
    expect(dedupeImages(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
    expect(dedupeImages([])).toEqual([]);
  });
});
