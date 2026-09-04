// How much an admin may attach to ONE save, and why there is a ceiling at all.
//
// A Worker buffers the entire multipart body in memory before a route sees it
// (`await request.formData()`), and only then can per-file sizes be checked. So
// the 8 MB-per-image cap in images.server.ts is not a limit on what the request
// COSTS us — twenty 8 MB photos is a 160 MB body that each pass that cap
// individually. Past a certain total the request dies before any of our error
// handling runs:
//
//   * Cloudflare rejects the body outright (100 MB on Free/Pro);
//   * the Worker exceeds its 128 MB memory ceiling — formData holds every file,
//     and each upload then copies one into an ArrayBuffer on top of that;
//   * or the sequential `bucket.put` + Images `info()` calls run out of CPU.
//
// All three surface the same way: the platform returns an HTML error page
// instead of an action result, React Router cannot parse it as a `.data`
// response, and the guest sees root.tsx's ErrorBoundary — "An unexpected error
// occurred", with no clue that the answer is "attach fewer photos". Hence a
// batch limit, checked in the browser (so the user is told before spending the
// upload) and again in the action (so it is actually enforced).
//
// Pure module: no bindings, shared by the server routes and the FilePicker.

/** Per-image cap. The single definition — images.server.ts enforces it on the
 *  bytes it is about to store, and the browser pre-checks against it. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Images per save. Sequential uploads cost two subrequests each (the R2 put
 *  and the Images `info()` that reads the intrinsic size), so this is about CPU
 *  and wall-clock as much as bytes. */
export const MAX_UPLOAD_FILES = 12;

/**
 * Bytes per save, across all attached images.
 *
 * Deliberately far below the 100 MB body limit rather than just under it: the
 * binding constraint is the 128 MB Worker memory ceiling, and the body is only
 * the first copy of the data. 40 MB leaves room for the buffered body, the
 * per-file ArrayBuffer, and the runtime itself, with headroom to spare.
 */
export const MAX_UPLOAD_TOTAL_BYTES = 40 * 1024 * 1024;

/** Only what a limit check needs, so this works on a browser `File` and on the
 *  `File`s a Worker parses out of a multipart body alike. */
export interface SizedFile {
  name: string;
  size: number;
}

export type UploadBatchProblem =
  | { kind: "count"; got: number; limit: number }
  | { kind: "file"; name: string; size: number; limit: number }
  | { kind: "total"; got: number; limit: number };

/** Megabytes, for messages. Whole numbers for the limits (they are exact
 *  multiples); one decimal for a measured size, so a 8.4 MB file is not
 *  reported as "8MB, max 8MB". */
export function mb(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The first limit `files` breaks, or null when the batch is fine.
 *
 * Count first, then per-file, then the total — the most specific complaint an
 * admin can act on. Naming the offending file matters: "one of your photos is
 * too big" sends someone back through fifteen thumbnails.
 */
export function checkUploadBatch(files: readonly SizedFile[]): UploadBatchProblem | null {
  if (files.length > MAX_UPLOAD_FILES) {
    return { kind: "count", got: files.length, limit: MAX_UPLOAD_FILES };
  }
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      return { kind: "file", name: file.name, size: file.size, limit: MAX_IMAGE_BYTES };
    }
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_UPLOAD_TOTAL_BYTES) {
    return { kind: "total", got: total, limit: MAX_UPLOAD_TOTAL_BYTES };
  }
  return null;
}

/**
 * The problem as an English sentence, for an action's `{ error }`.
 *
 * English on purpose: every other error these actions return is English too
 * (see "Enter a room name."), and the admin dictionaries cover the UI rather
 * than server responses. The browser-side copy in FilePicker IS translated —
 * that is the message an admin actually sees, because the client check fires
 * first. This one is the backstop for a submission that skipped it.
 */
export function uploadProblemMessage(problem: UploadBatchProblem): string {
  switch (problem.kind) {
    case "count":
      return `Too many photos at once (${problem.got}, max ${problem.limit}). Upload them in smaller batches.`;
    case "file":
      return `"${problem.name}" is too large (${mb(problem.size)}MB, max ${mb(problem.limit)}MB).`;
    case "total":
      return `Those photos total ${mb(problem.got)}MB, over the ${mb(problem.limit)}MB limit for one upload. Add them in smaller batches.`;
  }
}

/** The image `File`s an admin attached under `field`, ignoring the empty entry
 *  a file input posts when nothing is chosen. Every multi-file upload route
 *  needs exactly this, and each had its own copy of the predicate. */
export function attachedFiles(form: FormData, field: string): File[] {
  return form.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
}
