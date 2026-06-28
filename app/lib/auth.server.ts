import { createCookieSessionStorage, redirect } from "react-router";

import { getConfig } from "./config.server";
import { sendEmail } from "./email.server";
import { getUser, isSuperadmin, upsertUser } from "./users.server";

const TOKEN_TTL_MS = 15 * 60 * 1000; // magic links valid for 15 minutes

// ---------- base64url helpers ----------
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const enc = (s: string) => new TextEncoder().encode(s);

// ---------- HMAC-signed magic-link tokens ----------
async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc(payload));
  return toBase64Url(new Uint8Array(sig));
}

export async function createMagicToken(email: string): Promise<string> {
  const { sessionSecret } = getConfig();
  const payload = toBase64Url(enc(JSON.stringify({ email, exp: Date.now() + TOKEN_TTL_MS })));
  const sig = await sign(payload, sessionSecret);
  return `${payload}.${sig}`;
}

export async function verifyMagicToken(token: string): Promise<string | null> {
  const { sessionSecret } = getConfig();
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if ((await sign(payload, sessionSecret)) !== sig) return null;
  try {
    const { email, exp } = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (typeof email !== "string" || typeof exp !== "number" || Date.now() > exp) return null;
    return email.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedEmail(email: string): boolean {
  const { adminEmails } = getConfig();
  // No allowlist configured => open access (fine for testing; set ADMIN_EMAILS to lock down).
  if (adminEmails.length === 0) return true;
  return adminEmails.includes(email.trim().toLowerCase());
}

/** Whether this email may sign in: on the ADMIN_EMAILS allowlist (or it's empty,
 *  = open self-signup), OR they're an already-known user — so a teammate invited
 *  by an owner can sign in even after sign-up is locked down with ADMIN_EMAILS. */
export async function canSignIn(email: string): Promise<boolean> {
  if (isAllowedEmail(email)) return true;
  if (await isSuperadmin(email)) return true;
  return Boolean(await getUser(email));
}

// ---------- session ----------
function sessionStorage() {
  const { sessionSecret, appUrl } = getConfig();
  return createCookieSessionStorage({
    cookie: {
      name: "__ibe_admin",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: appUrl.startsWith("https"),
      secrets: [sessionSecret],
      maxAge: 60 * 60 * 24 * 7, // 1 week
    },
  });
}

export async function createAdminSession(email: string, redirectTo: string) {
  // First sign-in creates the user record (member by default).
  await upsertUser(email);
  const storage = sessionStorage();
  const session = await storage.getSession();
  session.set("email", email.toLowerCase());
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await storage.commitSession(session) },
  });
}

export async function getAdminEmail(request: Request): Promise<string | null> {
  const storage = sessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  const email = session.get("email");
  return typeof email === "string" && (await canSignIn(email)) ? email : null;
}

export async function requireAdmin(request: Request): Promise<string> {
  const email = await getAdminEmail(request);
  if (!email) throw redirect("/admin/login");
  return email;
}

/** Requires the signed-in user to be a superadmin; bounces members to /admin. */
export async function requireSuperadmin(request: Request): Promise<string> {
  const email = await requireAdmin(request);
  if (!(await isSuperadmin(email))) throw redirect("/admin");
  return email;
}

/** The property id the admin last selected (multi-property switcher). */
export async function getSessionProperty(request: Request): Promise<string | null> {
  const storage = sessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  const p = session.get("property");
  return typeof p === "string" ? p : null;
}

/** Set the selected property, preserving the rest of the session. Returns the
 *  Set-Cookie header value for the caller to attach to its response. */
export async function setSessionProperty(request: Request, propertyId: string): Promise<string> {
  const storage = sessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  session.set("property", propertyId);
  return storage.commitSession(session);
}

export async function logout(request: Request) {
  const storage = sessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  return redirect("/admin/login", {
    headers: { "Set-Cookie": await storage.destroySession(session) },
  });
}

// ---------- email delivery ----------
/** Sends the magic link. Returns the link for on-screen display when no email
 *  provider is configured (dev), so you can click through without real email. */
export async function sendMagicLink(
  email: string,
  link: string,
): Promise<{ sent: boolean; link?: string }> {
  const { resendApiKey } = getConfig();
  // No provider configured: surface the link so dev sign-in still works.
  if (!resendApiKey) {
    console.log(`[admin] magic link for ${email}: ${link}`);
    return { sent: false, link };
  }
  const { sent } = await sendEmail({
    to: email,
    subject: "Your admin sign-in link",
    html: `<p>Click to sign in to the booking admin:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`,
  });
  return sent ? { sent: true } : { sent: false, link };
}
