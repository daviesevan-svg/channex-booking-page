import { createCookieSessionStorage, redirect } from "react-router";

import { createGuestMagicToken, verifyGuestMagicToken } from "./auth.server";
import { getConfig } from "./config.server";
import { type GuestSession, guestLoginDecision, sessionCanSee } from "./guest-session";

export { createGuestMagicToken, verifyGuestMagicToken };
// The rules themselves are pure and live in ./guest-session; routes import
// them from here so there is one door to the guest portal's auth.
export { guestLoginDecision, sessionCanSee, type GuestSession };

// Guest "manage my booking" session — separate from the admin session.
//
// A booking reference is not proof of who you are. Anyone who can make a
// booking can make one under someone else's email address, so a reference
// only ever proves knowledge of THAT record. Two things follow, and both are
// enforced by the shape of this module rather than by call-site discipline:
//
//  * A session is bound to the property it was proved at. The shared booking
//    host serves every hotel from one cookie domain, so an unscoped session
//    walks straight from /hotel-a/manage to /hotel-b/manage.
//  * A session proved by a reference alone is bound to that one record
//    (`only`). It can show the booking whose reference was typed in and
//    nothing else — which is safe precisely because there is nothing else to
//    reveal, not because the caller has been identified.
//
// A session with no `only` means the mailbox itself was proved, via a magic
// link, and may list everything for that email AT THAT PROPERTY.
//
// `getGuestSession` demands the property id and returns null on a mismatch:
// there is deliberately no way to ask "who is this?" without saying where.
const COOKIE = "__ibe_guest2"; // renamed from __ibe_guest: every pre-scoping
// session was email-wide and cross-property, so none of them may survive this
// change. A rename retires them all at once with no version parsing, and the
// old cookie simply expires.

function guestSessionStorage() {
  const { sessionSecret, appUrl } = getConfig();
  return createCookieSessionStorage({
    cookie: {
      name: COOKIE,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: appUrl.startsWith("https"),
      secrets: [sessionSecret],
      maxAge: 60 * 60 * 24 * 7, // 1 week
    },
  });
}

export async function createGuestSession(s: GuestSession, redirectTo: string) {
  const storage = guestSessionStorage();
  const session = await storage.getSession();
  session.set("email", s.email.toLowerCase());
  session.set("pid", s.pid);
  if (s.only) session.set("only", s.only);
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await storage.commitSession(session) },
  });
}

/** The session, but only if it belongs to `pid`. Null otherwise. */
export async function getGuestSession(request: Request, pid: string): Promise<GuestSession | null> {
  const storage = guestSessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  const email = session.get("email");
  const sessionPid = session.get("pid");
  if (typeof email !== "string" || typeof sessionPid !== "string") return null;
  if (sessionPid !== pid) return null;
  const only = session.get("only");
  return { email, pid, only: typeof only === "string" ? only : undefined };
}

export async function guestLogout(request: Request, redirectTo: string) {
  const storage = guestSessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await storage.destroySession(session) },
  });
}
