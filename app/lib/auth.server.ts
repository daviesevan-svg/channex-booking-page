import { createCookieSessionStorage, redirect } from "react-router";

import { getConfig, getConfigKV } from "./config.server";
import { sendEmail } from "./email.server";
import { getUser, isSuperadmin, upsertUser } from "./users.server";

// ---------- base64url helpers ----------
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const enc = (s: string) => new TextEncoder().encode(s);

// ---------- HMAC signing (used to hash sign-in codes) ----------
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

// ---------- emailed sign-in codes ----------
const CODE_TTL_MS = 10 * 60 * 1000; // codes valid for 10 minutes
const CODE_MAX_ATTEMPTS = 5;
const codeKey = (email: string) => `login_code:${email.toLowerCase()}`;

interface CodeRecord {
  codeHash: string;
  exp: number;
  attempts: number;
}

async function hashCode(code: string): Promise<string> {
  return sign(code.trim(), getConfig().sessionSecret);
}

/** Generate a 6-digit sign-in code, store its hash (10-min TTL) and email it. In
 *  local dev (localhost APP_URL) the code is also logged to the server console so
 *  you can sign in without real email — never logged in production. */
export async function requestLoginCode(email: string): Promise<{ sent: boolean }> {
  const lc = email.toLowerCase();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const kv = getConfigKV();
  if (kv) {
    const rec: CodeRecord = { codeHash: await hashCode(code), exp: Date.now() + CODE_TTL_MS, attempts: 0 };
    await kv.put(codeKey(lc), JSON.stringify(rec), { expirationTtl: 600 });
  }
  if (getConfig().appUrl.startsWith("http://localhost")) {
    console.log(`[admin] sign-in code for ${lc}: ${code}`);
  }
  const { sent } = await sendEmail({
    to: lc,
    subject: "Your admin sign-in code",
    html:
      `<p>Your sign-in code for the booking admin is:</p>` +
      `<p style="font-size:26px;font-weight:700;letter-spacing:4px">${code}</p>` +
      `<p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
  });
  return { sent };
}

/** Verify an emailed code. Consumes it on success; counts attempts and locks the
 *  code after CODE_MAX_ATTEMPTS so a 6-digit code can't be brute-forced. */
export async function verifyLoginCode(
  email: string,
  code: string,
): Promise<{ ok: boolean; reason?: "expired" | "locked" | "wrong" }> {
  const kv = getConfigKV();
  if (!kv) return { ok: false, reason: "expired" };
  const key = codeKey(email);
  const raw = await kv.get(key);
  if (!raw) return { ok: false, reason: "expired" };
  let rec: CodeRecord;
  try {
    rec = JSON.parse(raw) as CodeRecord;
  } catch {
    await kv.delete(key);
    return { ok: false, reason: "expired" };
  }
  if (Date.now() > rec.exp) {
    await kv.delete(key);
    return { ok: false, reason: "expired" };
  }
  if (rec.attempts >= CODE_MAX_ATTEMPTS) {
    await kv.delete(key);
    return { ok: false, reason: "locked" };
  }
  if ((await hashCode(code)) === rec.codeHash) {
    await kv.delete(key);
    return { ok: true };
  }
  await kv.put(key, JSON.stringify({ ...rec, attempts: rec.attempts + 1 }), { expirationTtl: 600 });
  return { ok: false, reason: "wrong" };
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

