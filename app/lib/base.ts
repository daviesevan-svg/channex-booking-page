// Where a guest page lives, so every link works on both address shapes.
//
// The booking engine serves each property twice:
//
//   shared domain   book.roompanda.com/spilmanhotel/rooms
//   custom domain   www.spilmanhotel.co.uk/rooms
//
// so a link cannot be written as a fixed path. It needs a prefix that is
// `/spilmanhotel` in the first case and empty in the second.
//
// The signal is the route param, not the hostname. On the shared domain the
// guest tree is mounted under `:channelId`, so `params.channelId` holds the
// slug. On a custom domain the same tree is mounted at the root, that segment
// does not exist, and `params.channelId` is undefined — which is exactly the
// case that wants an empty prefix. Nothing here has to know about hostnames,
// custom domains, or which property is being served.
//
// Always compose as `` `${base}/rooms` ``, never `` `${base}rooms` `` — base is
// a prefix without a trailing slash, so the leading slash belongs to the path.
// On a custom domain that yields `/rooms`; on the shared domain
// `/spilmanhotel/rooms`.

import { useParams } from "react-router";

/**
 * URL prefix for links to this property's guest pages.
 *
 * Pass `params.channelId` from a loader, action, or component. Undefined or
 * empty means the hostname already identifies the property, so the prefix is
 * empty and links sit at the root.
 */
export function basePath(channelId: string | undefined): string {
  return isPathSegment(channelId) ? `/${channelId}` : "";
}

/**
 * A `:channelId` a link may be built from: a slug or an id, nothing else.
 *
 * The router decodes the segment before it reaches us, so `%2F%2Fevil.com` and
 * `%5C%5Cevil.com` arrive as `//evil.com` and `\\evil.com` — and `/${that}` is
 * `///evil.com`, which every browser reads as an absolute URL. A `redirect()`
 * built from it would send the guest off-site from the hotel's own booking
 * origin. No real property has such a segment, so treating it as "no
 * property" (a root link) loses nothing.
 */
export function isPathSegment(channelId: string | undefined): channelId is string {
  return !!channelId && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(channelId);
}

/** `basePath` for components — reads the param from the current route match. */
export function useBase(): string {
  return basePath(useParams().channelId);
}

/**
 * The property's home page, as a URL you can navigate to on its own.
 *
 * Use this instead of a bare `` `${base}` ``. `basePath` returns a PREFIX, and on
 * a custom domain that prefix is the empty string — so `redirect(`${base}`)`
 * redirects to "", which resolves to the current URL and loops, and `<Link to={base}>`
 * goes nowhere. Both are silent: nothing throws, the page just stops working.
 */
export function homePath(channelId: string | undefined): string {
  return isPathSegment(channelId) ? `/${channelId}` : "/";
}

/** `homePath` for components. */
export function useHome(): string {
  return homePath(useParams().channelId);
}
