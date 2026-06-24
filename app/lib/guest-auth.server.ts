import { createCookieSessionStorage, redirect } from "react-router";

import { getConfig } from "./config.server";

// Guest "manage my booking" session — separate from the admin session. The
// guest proves ownership by entering a valid booking reference + email, after
// which we trust the email for this browser.
function guestSessionStorage() {
  const { sessionSecret, appUrl } = getConfig();
  return createCookieSessionStorage({
    cookie: {
      name: "__ibe_guest",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: appUrl.startsWith("https"),
      secrets: [sessionSecret],
      maxAge: 60 * 60 * 24 * 7, // 1 week
    },
  });
}

export async function createGuestSession(email: string, redirectTo: string) {
  const storage = guestSessionStorage();
  const session = await storage.getSession();
  session.set("email", email.toLowerCase());
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await storage.commitSession(session) },
  });
}

export async function getGuestEmail(request: Request): Promise<string | null> {
  const storage = guestSessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  const email = session.get("email");
  return typeof email === "string" ? email : null;
}

export async function guestLogout(request: Request, redirectTo: string) {
  const storage = guestSessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await storage.destroySession(session) },
  });
}
