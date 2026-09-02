import { describe, expect, it } from "vitest";

import { basePath, homePath, isPathSegment } from "./base";

describe("basePath / homePath", () => {
  it("prefixes a slug or id on the shared domain", () => {
    expect(basePath("spilmanhotel")).toBe("/spilmanhotel");
    expect(homePath("439ec597-8caf-47be-b07d-663a9602c79c")).toBe("/439ec597-8caf-47be-b07d-663a9602c79c");
  });

  it("is empty / root on a custom domain (no segment)", () => {
    expect(basePath(undefined)).toBe("");
    expect(homePath(undefined)).toBe("/");
    expect(homePath("")).toBe("/");
  });

  it("never builds a protocol-relative URL from a decoded segment", () => {
    // The router hands `%2F%2Fevil.com` to loaders as `//evil.com`; a redirect to
    // `///evil.com` leaves the site. Same for backslashes and anything else that
    // could not be a slug or an id.
    for (const bad of ["//evil.com", "\\\\evil.com", "/evil", "a/b", "evil.com\\", "-x", ".."]) {
      expect(homePath(bad)).toBe("/");
      expect(basePath(bad)).toBe("");
      expect(isPathSegment(bad)).toBe(false);
    }
  });
});
