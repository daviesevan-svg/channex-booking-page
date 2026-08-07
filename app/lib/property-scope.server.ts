// Which property a guest request is for.
//
// The guest tree is mounted twice, so a loader can arrive either way:
//
//   /spilmanhotel/rooms          shared domain — property is in the path
//   /rooms  (spilmanhotel.co.uk) custom domain — property is the hostname
//
// Every guest loader resolves through here rather than reading
// `params.channelId` directly, because on the root mount that param does not
// exist. A loader that used it alone would look up `undefined` and quietly serve
// the default property on a hotel's own domain — the wrong hotel's rooms and
// prices, with no error anywhere.
//
// Child loaders run in PARALLEL with the layout's, so they cannot lean on the
// layout having already validated the property. This throws its own 404.

import { isOwnHost, propertyIdForHost } from "./domains.server";
import { partnerIdForGuestHost } from "./partners.server";
import { getProperty, resolvePropertyId } from "./properties.server";

/**
 * The property id for this request — from the `:channelId` segment when there is
 * one, otherwise from the hostname. Throws a 404 when neither resolves.
 *
 * The hostname is only consulted when there is no segment, so requests on the
 * shared domain do no extra lookup.
 */
export async function resolveRequestProperty(
  channelId: string | undefined,
  request: Request,
): Promise<string> {
  const pid = await resolveRequestPropertyOrNull(channelId, request);
  if (!pid) throw new Response("Not found", { status: 404 });
  return pid;
}

/**
 * Same resolution, but null instead of a 404 when there is no property.
 *
 * Only "/" needs this. That URL is the shared domain's own front door (the
 * property picker) and a hotel's home page on their custom domain, so "no
 * property" is a legitimate outcome there rather than a missing page. Everywhere
 * else, use `resolveRequestProperty` — a guest route with no property has
 * nothing to render, and returning null would let it half-render instead.
 */
export async function resolveRequestPropertyOrNull(
  channelId: string | undefined,
  request: Request,
): Promise<string | null> {
  const hostname = new URL(request.url).hostname;
  if (channelId) {
    const pid = await resolvePropertyId(channelId);
    if (!pid) return null;
    // Slug paths are host-disciplined. On our shared domain every property
    // resolves, as always. On a white-label partner's guest host, ONLY that
    // partner's properties exist — book.theirpms.com/otherhotel serving a
    // stranger's booking page would put one tenant on another's brand. On any
    // other hostname (a hotel's custom domain, a partner ADMIN host) the slug
    // mount doesn't exist at all: those hosts serve exactly one thing, and a
    // slug path there was never a real URL — just an unadvertised alias this
    // used to answer anyway.
    if (isOwnHost(hostname)) return pid;
    const partnerId = await partnerIdForGuestHost(hostname);
    if (partnerId) return (await getProperty(pid))?.partnerId === partnerId ? pid : null;
    return null;
  }
  return propertyIdForHost(hostname);
}
