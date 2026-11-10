// One SESSION_SECRET, one key PER PURPOSE.
//
// The admin session cookie, the guest-portal session cookie and the emailed
// magic links were all signed with SESSION_SECRET itself. A signature made for
// one of them therefore verified as any of the others: the cookie library
// signs only the VALUE (the cookie's name is not part of the MAC), and a magic
// link is the same `payload.signature` shape as a cookie. So a guest-portal
// cookie — which anyone can obtain for any email address by making a booking
// under it — was a valid admin cookie for that address, and a used or expired
// sign-in link was a session that never expired.
//
// Deriving a distinct key for each purpose makes every such crossover fail at
// the signature, whatever the payload says. Field checks (`aud`, `partner`,
// `pid`) stay as a second layer, not the only one.
//
// SESSION_SECRET itself is NOT rotated and keeps its other jobs untouched (API
// key hashes in api-auth.server, preview tokens, the analytics visit key):
// rotating it would revoke every issued API key.
import { getConfig } from "./config.server";

export type SigningPurpose = "admin-session" | "guest-session" | "magic-link";

/** The HMAC key for one purpose. Never use SESSION_SECRET directly to sign
 *  something a browser or a mailbox will hand back — add a purpose here. */
export function signingKey(purpose: SigningPurpose): string {
  return `${getConfig().sessionSecret}::ibe:${purpose}:v1`;
}
