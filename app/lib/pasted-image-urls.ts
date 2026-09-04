// The room editor's "Or add image URLs (one per line)" box.
//
// This field took whatever it was given. `not-a-url`, `://broken`, a pasted
// `data:` URI and a stray `<script>` tag all saved happily and became room
// photos — rendering as broken images on the guest page, with nothing anywhere
// telling the admin they had mistyped. (They are escaped, so this was never an
// injection; it was a silent way to break a room's gallery permanently.)
//
// Two shapes are legitimate:
//
//   * an absolute `https://` url — someone else's server, hosting a photo we
//     link rather than store;
//   * one of our own `/images/<kind>/<property>/…` paths, so a photo already in
//     the bucket can be reused on another room without re-uploading it.
//
// `http://` is refused rather than accepted-and-upgraded: guest pages are
// https, so a plain-http image is blocked as mixed content and shows as a
// broken picture — exactly the failure this is meant to stop, just later.
//
// Pure module: no bindings, safe in tests.
import { isPropertyImageUrl } from "./image-paths";

/** One accepted url, or null with the reason it was refused. */
function checkOne(value: string): string | null {
  if (isPropertyImageUrl(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "must be a full https:// url";
  }
  if (parsed.protocol !== "https:") return "must start with https://";
  if (!parsed.hostname) return "has no domain";
  return null;
}

export interface PastedImageUrls {
  /** Accepted urls, in the order given, without blanks or repeats. */
  urls: string[];
  /** `line` as typed plus `reason`, for an error naming what to fix. */
  rejected: { line: string; reason: string }[];
}

/**
 * Split the textarea into urls, keeping the good ones and reporting the rest.
 *
 * Never throws and never silently drops a non-empty line: a line is either in
 * `urls` or in `rejected`, so the caller can refuse the save and say which line
 * was wrong.
 */
export function parsePastedImageUrls(raw: string): PastedImageUrls {
  const urls: string[] = [];
  const rejected: { line: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const value = line.trim();
    if (!value) continue;
    const reason = checkOne(value);
    if (reason) {
      rejected.push({ line: value, reason });
      continue;
    }
    // A url pasted twice is one photo, not two — and a duplicate in a room's
    // `images` gives the editor's "Current photos" grid two <label>s with the
    // same React key.
    if (seen.has(value)) continue;
    seen.add(value);
    urls.push(value);
  }
  return { urls, rejected };
}

/** The refusals as one English sentence for an action's `{ error }` (see
 *  imageProblemMessage in upload-limits.ts on why these stay English). Only
 *  the first two lines are named — a mis-paste is usually the whole box, and a
 *  twenty-line error is not more helpful than a two-line one. */
export function pastedUrlError(rejected: PastedImageUrls["rejected"]): string {
  const shown = rejected
    .slice(0, 2)
    .map((r) => `"${r.line.slice(0, 60)}" ${r.reason}`)
    .join("; ");
  const rest = rejected.length > 2 ? ` (and ${rejected.length - 2} more)` : "";
  return `Check the image URLs: ${shown}${rest}.`;
}

/** `images` with repeats removed, first occurrence winning. The saved list is
 *  built from three sources (kept, uploaded, pasted) that can name the same
 *  photo. */
export function dedupeImages(images: readonly string[]): string[] {
  return [...new Set(images)];
}
