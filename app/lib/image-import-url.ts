/** Booking.com CDN only. Used by importImageFromUrl (the fetch must refuse
 *  anything else so a future caller cannot SSRF) and by the onboard form
 *  filter so the two cannot drift. Matches `*.bstatic.com`. */
const BSTATIC_HOST = /(^|\.)bstatic\.com$/i;

export function isAllowedImportImageParsed(u: URL): boolean {
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  return BSTATIC_HOST.test(u.hostname);
}

/** True when `url` is an https Booking.com CDN image URL (no credentials,
 *  no odd ports). */
export function isAllowedImportImageUrl(url: string): boolean {
  try {
    return isAllowedImportImageParsed(new URL(url));
  } catch {
    return false;
  }
}
