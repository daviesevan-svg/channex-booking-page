import { describe, expect, it } from "vitest";

import {
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_BYTES,
  attachedFiles,
  checkUploadBatch,
  mb,
  uploadProblemMessage,
} from "./upload-limits";

const MB = 1024 * 1024;
const file = (name: string, sizeMb: number) => ({ name, size: Math.round(sizeMb * MB) });

describe("checkUploadBatch", () => {
  it("passes a normal room gallery", () => {
    expect(checkUploadBatch([])).toBeNull();
    expect(checkUploadBatch([file("a.jpg", 3)])).toBeNull();
    expect(checkUploadBatch(Array.from({ length: 8 }, (_, i) => file(`p${i}.jpg`, 2)))).toBeNull();
  });

  it("allows exactly the limits", () => {
    expect(checkUploadBatch([file("big.jpg", MAX_IMAGE_BYTES / MB)])).toBeNull();
    const each = MAX_UPLOAD_TOTAL_BYTES / MAX_UPLOAD_FILES / MB;
    expect(
      checkUploadBatch(Array.from({ length: MAX_UPLOAD_FILES }, (_, i) => file(`p${i}.jpg`, each))),
    ).toBeNull();
  });

  it("refuses more files than one request can process", () => {
    const files = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => file(`p${i}.jpg`, 0.1));
    expect(checkUploadBatch(files)).toEqual({
      kind: "count",
      got: MAX_UPLOAD_FILES + 1,
      limit: MAX_UPLOAD_FILES,
    });
  });

  it("names the oversized file rather than the batch", () => {
    const problem = checkUploadBatch([file("fine.jpg", 1), file("huge.jpg", 9)]);
    expect(problem).toMatchObject({ kind: "file", name: "huge.jpg" });
  });

  // The bug this module exists for: each photo is under the per-file cap, so
  // the old per-file check passed all of them, and the request then died
  // buffering 140 MB with no error an admin could read.
  it("refuses a total that no single file breaks", () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`phone-${i}.jpg`, 7));
    expect(files.every((f) => f.size <= MAX_IMAGE_BYTES)).toBe(true);
    expect(checkUploadBatch(files)).toMatchObject({ kind: "total", limit: MAX_UPLOAD_TOTAL_BYTES });
  });

  it("reports count before size, so the actionable complaint comes first", () => {
    const files = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => file(`p${i}.jpg`, 9));
    expect(checkUploadBatch(files)?.kind).toBe("count");
  });
});

describe("mb", () => {
  it("keeps whole limits whole and measured sizes precise", () => {
    expect(mb(8 * MB)).toBe("8");
    expect(mb(40 * MB)).toBe("40");
    // Would otherwise read "8MB, max 8MB" and look like a bug in the check.
    expect(mb(8.4 * MB)).toBe("8.4");
  });
});

describe("uploadProblemMessage", () => {
  it("tells the admin what to do about it", () => {
    expect(uploadProblemMessage({ kind: "count", got: 30, limit: 12 })).toContain("smaller batches");
    expect(uploadProblemMessage({ kind: "file", name: "sea.jpg", size: 9 * MB, limit: 8 * MB })).toBe(
      '"sea.jpg" is too large (9MB, max 8MB).',
    );
    expect(uploadProblemMessage({ kind: "total", got: 140 * MB, limit: 40 * MB })).toContain("140MB");
  });
});

describe("attachedFiles", () => {
  it("returns the chosen files and ignores an empty pick", () => {
    const form = new FormData();
    form.append("uploads", new File(["xx"], "a.jpg", { type: "image/jpeg" }));
    // What a file input posts when nothing is selected.
    form.append("uploads", new File([], "", { type: "application/octet-stream" }));
    form.append("other", new File(["yy"], "b.jpg", { type: "image/jpeg" }));

    expect(attachedFiles(form, "uploads").map((f) => f.name)).toEqual(["a.jpg"]);
    expect(attachedFiles(form, "missing")).toEqual([]);
  });

  it("ignores a text field posted under the same name", () => {
    const form = new FormData();
    form.append("uploads", "not a file");
    expect(attachedFiles(form, "uploads")).toEqual([]);
  });
});
