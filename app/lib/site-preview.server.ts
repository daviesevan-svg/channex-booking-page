// The design screen's preview link: permission to render a property's own public
// page with a template and typeface that are not (yet) the saved ones.
//
// A signed token rather than the admin session, because the preview crosses a
// host boundary the session deliberately cannot. A white-label partner's back
// office is on their admin host and their hotels' public pages are on their
// guest host, and sessions are bound to the door they were minted at
// (auth.server) — so the cookie is simply not there to read. Carrying the
// permission IN the URL is the only thing that works on both hosts, and it works
// identically on our shared domain, so there is one path rather than two.
//
// What the token grants is cosmetic: the same public page, with a different
// stylesheet. It is bound to one property so a token minted for one hotel can't
// restyle another's page, and it expires — a stale link renders the saved design
// rather than an error, which is the right failure for a preview.

import { getConfig } from "./config.server";
import { hmacSha256Hex, timingSafeEqual } from "./hmac.server";

/** Long enough that an operator can sit on the design screen trying templates
 *  all afternoon and still have the iframe (and "Open in a new tab") work. */
const TTL_MS = 12 * 60 * 60 * 1000;

const payload = (propertyId: string, exp: number) => `preview:${propertyId}:${exp}`;

export async function createPreviewToken(propertyId: string): Promise<string> {
  const exp = Date.now() + TTL_MS;
  const sig = await hmacSha256Hex(getConfig().sessionSecret, payload(propertyId, exp));
  return `${exp}.${sig}`;
}

/** True when `token` was minted by us for `propertyId` and hasn't expired. */
export async function verifyPreviewToken(token: string, propertyId: string): Promise<boolean> {
  const [expRaw, sig] = token.split(".");
  const exp = Number(expRaw);
  if (!expRaw || !sig || !Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = await hmacSha256Hex(getConfig().sessionSecret, payload(propertyId, exp));
  return timingSafeEqual(expected, sig);
}
