import { describe, expect, it } from "vitest";

import {
  MAX_IMAGE_BYTES,
  imageProblem,
  imageProblemMessage,
  imageProblemText,
  mb,
} from "./upload-limits";

// The batch limits these tests used to cover are gone with the batched
// uploaders — every photo is its own request now, so nothing carries more than
// one. What is left is the per-image cap and the type check, which run twice
// (browser then endpoint) and so have to agree.

const MB = 1024 * 1024;
const file = (name: string, sizeMb: number, type = "image/jpeg") => ({
  name,
  size: sizeMb * MB,
  type,
});

describe("imageProblem", () => {
  it("passes an image inside the cap, including one exactly at it", () => {
    expect(imageProblem(file("a.jpg", 3))).toBeNull();
    expect(imageProblem({ name: "edge.jpg", size: MAX_IMAGE_BYTES, type: "image/jpeg" })).toBeNull();
  });

  it("names the file and its size when it is over the cap", () => {
    expect(imageProblem(file("sea.jpg", 9))).toEqual({
      kind: "size",
      name: "sea.jpg",
      size: 9 * MB,
    });
  });

  it("refuses a non-image", () => {
    expect(imageProblem(file("deck.pdf", 1, "application/pdf"))).toEqual({
      kind: "type",
      name: "deck.pdf",
    });
  });

  it("allows a file whose type the browser could not sniff", () => {
    // An empty `type` is what some platforms report; refusing it would block an
    // upload the server would have accepted.
    expect(imageProblem({ name: "photo", size: MB, type: "" })).toBeNull();
    expect(imageProblem({ name: "photo", size: MB })).toBeNull();
  });

  it("reports the type before the size, so the message is the actionable one", () => {
    expect(imageProblem(file("movie.mov", 40, "video/quicktime"))).toMatchObject({ kind: "type" });
  });
});

describe("imageProblemText", () => {
  // The dictionary's lookup, structurally — asserting the key and vars rather
  // than English copy, which is what the caller actually depends on.
  const t = (key: string, vars?: Record<string, string | number>) =>
    `${key}:${JSON.stringify(vars ?? {})}`;

  it("asks for the too-big message with the file, its size and the limit", () => {
    expect(imageProblemText(t, { kind: "size", name: "sea.jpg", size: 9 * MB })).toBe(
      'puTooBig:{"name":"sea.jpg","size":"9","limit":"8"}',
    );
  });

  it("asks for the not-an-image message with the file", () => {
    expect(imageProblemText(t, { kind: "type", name: "deck.pdf" })).toBe(
      'puNotImage:{"name":"deck.pdf"}',
    );
  });
});

describe("imageProblemMessage", () => {
  // The endpoint's backstop, in English — see the comment on it.
  it("says which file and by how much", () => {
    expect(imageProblemMessage({ kind: "size", name: "sea.jpg", size: 9.4 * MB })).toBe(
      '"sea.jpg" is 9.4MB — the limit is 8MB per photo.',
    );
    expect(imageProblemMessage({ kind: "type", name: "deck.pdf" })).toBe(
      '"deck.pdf" is not an image.',
    );
  });
});

describe("mb", () => {
  it("keeps the limit whole and a measured size to one decimal", () => {
    // Otherwise an 8.4MB file is reported as "8MB, max 8MB".
    expect(mb(MAX_IMAGE_BYTES)).toBe("8");
    expect(mb(8.4 * MB)).toBe("8.4");
    expect(mb(40 * MB)).toBe("40");
  });
});
