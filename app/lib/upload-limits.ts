// What one uploaded image may be, and the one message that says why not.
//
// This file used to hold a BATCH limit — 12 files, 40 MB in total — because
// every admin uploader posted its whole pick inside the form's own submit, and
// a Worker buffers that entire multipart body in memory (`request.formData()`)
// before a route sees any of it. Past a certain total the request died before
// our error handling ran and the admin got root's ErrorBoundary, so the batch
// had to be capped.
//
// Uploads now go one file per request (room-photo.tsx, gallery-photo.tsx,
// section-photo.tsx), so no request ever carries more than one photo and there
// is nothing for a batch limit to protect. What remains is the per-image cap,
// which is a real product decision rather than a platform workaround, plus the
// type check — and both are needed in two places, so they live here rather
// than being written twice:
//
//   * the browser, so a file is refused before the upload is spent;
//   * the endpoint, which is where it is actually enforced.
//
// Pure module: no bindings, no React, no i18n import. Safe on both sides.

/** Per-image cap. images.server.ts enforces it on the bytes it is about to
 *  store; the browser and the upload endpoints pre-check against it. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Only what a check needs, so this works on a browser `File` and on the
 *  `File`s a Worker parses out of a multipart body alike. */
export interface CheckableFile {
  name: string;
  size: number;
  /** Absent on some platform File shapes; an empty type is not a refusal. */
  type?: string;
}

export type ImageProblem =
  | { kind: "type"; name: string }
  | { kind: "size"; name: string; size: number };

/** Megabytes, for messages. Whole numbers for the limit (it is an exact
 *  multiple); one decimal for a measured size, so an 8.4 MB file is not
 *  reported as "8MB, max 8MB". */
export function mb(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Why this file cannot be uploaded, or null when it can. Naming the offending
 *  file matters: "one of your photos is too big" sends someone back through
 *  fifteen thumbnails. */
export function imageProblem(file: CheckableFile): ImageProblem | null {
  // An empty `type` is what a browser reports for some files it cannot sniff;
  // refusing those would block a legitimate upload the server would accept.
  if (file.type && !file.type.startsWith("image/")) return { kind: "type", name: file.name };
  if (file.size > MAX_IMAGE_BYTES) return { kind: "size", name: file.name, size: file.size };
  return null;
}

/** The admin dictionary's lookup, structurally — so this module needs no
 *  import from admin-i18n and stays usable on the server. */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The problem as translated copy. One implementation for both pickers: the
 *  two used byte-identical strings under two different keys, which is exactly
 *  how one of them drifts. */
export function imageProblemText(t: Translate, problem: ImageProblem): string {
  return problem.kind === "type"
    ? t("puNotImage", { name: problem.name })
    : t("puTooBig", { name: problem.name, size: mb(problem.size), limit: mb(MAX_IMAGE_BYTES) });
}

/** The problem as an English sentence, for an endpoint's `{ error }`.
 *
 *  English on purpose: every other error these routes return is English too,
 *  and the admin dictionaries cover the UI rather than server responses. The
 *  browser-side copy above IS translated — that is the message an admin
 *  normally sees, because the client check fires first. This is the backstop
 *  for a request that skipped it. */
export function imageProblemMessage(problem: ImageProblem): string {
  return problem.kind === "type"
    ? `"${problem.name}" is not an image.`
    : `"${problem.name}" is ${mb(problem.size)}MB — the limit is ${mb(MAX_IMAGE_BYTES)}MB per photo.`;
}
