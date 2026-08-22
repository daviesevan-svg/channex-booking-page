import { describe, expect, it } from "vitest";

import { timingSafeEqual } from "./hmac.server";

describe("timingSafeEqual", () => {
  it("accepts identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("rejects a different signature of the same length", () => {
    expect(timingSafeEqual("abcd", "abce")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    expect(timingSafeEqual("short", "longer-than-short")).toBe(false);
    expect(timingSafeEqual("longer-than-short", "short")).toBe(false);
  });

  it("treats base64url HMAC bytes like verifyMagicToken will pass it", () => {
    const expected = "qK-8vN0xY2w";
    expect(timingSafeEqual(expected, expected)).toBe(true);
    expect(timingSafeEqual(expected, "qK-8vN0xY2x")).toBe(false);
    expect(timingSafeEqual(expected, "qK-8vN0xY2")).toBe(false);
  });
});
