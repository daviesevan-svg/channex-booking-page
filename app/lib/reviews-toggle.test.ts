import { describe, expect, it } from "vitest";

import { reviewsOn } from "./reviews";

describe("reviewsOn", () => {
  it("is on unless the property explicitly switched it off", () => {
    expect(reviewsOn(undefined)).toBe(true);
    expect(reviewsOn(null)).toBe(true);
    expect(reviewsOn({})).toBe(true);
    expect(reviewsOn({ reviewsEnabled: true })).toBe(true);
    expect(reviewsOn({ reviewsEnabled: false })).toBe(false);
  });
});
