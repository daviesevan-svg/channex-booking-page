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

import { propertyIdForHost } from "./domains.server";
import { resolvePropertyId } from "./properties.server";

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
  if (channelId) return resolvePropertyId(channelId);

  const pid = await propertyIdForHost(new URL(request.url).hostname);
  if (!pid) throw new Response("Not found", { status: 404 });
  return pid;
}
