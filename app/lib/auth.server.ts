import { createCookieSessionStorage, redirect } from "react-router";

import { getConfig, getConfigKV } from "./config.server";
import { sendEmail } from "./email.server";
import { claimSuperadminIfUnclaimed, getUser, isSuperadmin, upsertUser } from "./users.server";
import { brandForUser, getPartner, partnerIdForAdminHost } from "./partners.server";
import { isOwnHost } from "./domains.server";
import { timingSafeEqual } from "./hmac.server";
import { tokenAudienceOk } from "./guest-session";
import {
  generateConnectNonce,
  matchConnectState,
  parseConnectPending,
  STRIPE_CONNECT_SESSION_KEY,
} from "./stripe-connect-state";

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
  // jti makes the link single-use: it's marked consumed in KV on first verify.
  const jti = crypto.randomUUID();
  const payload = toBase64Url(enc(JSON.stringify({ email, exp: Date.now() + TOKEN_TTL_MS, jti })));
  const sig = await sign(payload, sessionSecret);
  return `${payload}.${sig}`;
}

export async function verifyMagicToken(token: string): Promise<string | null> {
  const { sessionSecret } = getConfig();
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(await sign(payload, sessionSecret), sig)) return null;
  try {
    const { email, exp, jti, aud } = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (typeof email !== "string" || typeof exp !== "number" || Date.now() > exp) return null;
    // Audience: a token minted for the GUEST portal must never open the admin.
    // Both are signed with the same secret, and this verifier ignores unknown
    // fields — so without this check a guest link would satisfy /admin/verify
    // for any email that happens to be on the allowlist. Admin tokens carry no
    // `aud` (and the ones already in flight when this shipped carry none), so
    // undefined stays valid; anything else is somebody else's token.
    if (!tokenAudienceOk(aud, "admin")) return null;
    // Single-use: reject a token already consumed, then mark it consumed. We track
    // *consumption* (not issuance) so KV propagation lag never blocks a first, real
    // login — only a later replay of a leaked link is refused. Legacy tokens with
    // no jti skip this (they still expire in 15 min).
    if (typeof jti === "string") {
      const kv = getConfigKV();
      if (kv) {
        const usedKey = `magic_used:${jti}`;
        if (await kv.get(usedKey)) return null; // already used
        await kv.put(usedKey, "1", { expirationTtl: Math.ceil(TOKEN_TTL_MS / 1000) });
      }
    }
    return email.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A magic-link token for the GUEST portal, bound to one property.
 *
 * Lives here because this is where the signing key and the base64url helpers
 * are, not because it has anything to do with admin sign-in — the `aud` field
 * is what keeps the two apart, in both directions.
 *
 * The property is inside the signature on purpose: a link mailed for hotel A
 * must not open hotel B's portal on the shared host, and the pid is the only
 * thing that can say so once the link leaves our hands.
 */
export async function createGuestMagicToken(email: string, pid: string): Promise<string> {
  const { sessionSecret } = getConfig();
  const jti = crypto.randomUUID();
  const payload = toBase64Url(
    enc(JSON.stringify({ email, pid, aud: "guest", exp: Date.now() + TOKEN_TTL_MS, jti })),
  );
  return `${payload}.${await sign(payload, sessionSecret)}`;
}

/** Verify a guest link. Returns the email and the property it was minted for. */
export async function verifyGuestMagicToken(
  token: string,
): Promise<{ email: string; pid: string } | null> {
  const { sessionSecret } = getConfig();
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(await sign(payload, sessionSecret), sig)) return null;
  try {
    const { email, pid, aud, exp, jti } = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload)),
    );
    // No undefined-is-fine grace here: guest tokens are new, so every valid one
    // says so. An admin token must not open the portal either.
    if (!tokenAudienceOk(aud, "guest")) return null;
    if (typeof email !== "string" || typeof pid !== "string" || typeof exp !== "number") return null;
    if (Date.now() > exp) return null;
    // Single-use, same scheme as the admin link: consumption is what's tracked,
    // so KV lag never blocks a first real login, only a replay of a leaked link.
    if (typeof jti === "string") {
      const kv = getConfigKV();
      if (kv) {
        const usedKey = `magic_used:${jti}`;
        if (await kv.get(usedKey)) return null;
        await kv.put(usedKey, "1", { expirationTtl: Math.ceil(TOKEN_TTL_MS / 1000) });
      }
    }
    return { email: email.toLowerCase(), pid };
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

// ---------- admin hosts ----------
/**
 * The white-label partner whose ADMIN this request's host serves: null on our
 * own (canonical) hosts, the partner id on a registered partner admin host —
 * and a 404 for every other hostname.
 *
 * This replaces requireCanonicalHost for the admin surface. The wildcard
 * Worker route sends every custom hostname here, so an unrecognised host must
 * still 404 exactly as before — a hotel's website domain must never render our
 * (or a partner's) login form.
 */
export async function adminHostPartnerId(request: Request): Promise<string | null> {
  let host = "";
  try {
    host = new URL(request.url).hostname;
  } catch {
    throw new Response("Not found", { status: 404 });
  }
  if (isOwnHost(host)) return null;
  const partnerId = await partnerIdForAdminHost(host);
  if (partnerId) return partnerId;
  throw new Response("Not found", { status: 404 });
}

/**
 * Whether `email` may sign in through the door this request arrived at.
 *
 * On a partner host: that partner's users and superadmins only — and the user
 * record must already exist, so partner hosts are invite-only regardless of
 * ADMIN_EMAILS. On canonical hosts: today's rules, MINUS users whose partner
 * has its own admin host — their brand lives there, and letting them in here
 * would show them ours.
 */
export async function canSignInOnHost(email: string, hostPartnerId: string | null): Promise<boolean> {
  if (hostPartnerId) {
    if (await isSuperadmin(email)) return true;
    return (await getUser(email))?.partnerId === hostPartnerId;
  }
  if (!(await canSignIn(email))) return false;
  const partnerId = (await getUser(email))?.partnerId;
  if (!partnerId) return true;
  return !(await getPartner(partnerId))?.adminHost;
}

export async function createAdminSession(email: string, redirectTo: string, hostPartnerId: string | null = null) {
  // First sign-in creates the user record (member by default).
  await upsertUser(email);
  // Lockout-safe bootstrap: if no superadmin exists yet, this first sign-in
  // claims it (instead of treating everyone as superadmin). No-op once claimed
  // — and never from a partner host: a PMS's first hotel user must not claim
  // the platform.
  if (!hostPartnerId) await claimSuperadminIfUnclaimed(email);
  const storage = sessionStorage();
  const session = await storage.getSession();
  session.set("email", email.toLowerCase());
  // Bind the session to the door it was minted at. Browsers scope the cookie
  // per host anyway; this stops a copied cookie VALUE from crossing hosts.
  session.set("partner", hostPartnerId ?? "");
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await storage.commitSession(session) },
  });
}

export async function getAdminEmail(request: Request): Promise<string | null> {
  const hostPartnerId = await adminHostPartnerId(request); // 404s foreign hosts
  const storage = sessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  const email = session.get("email");
  if (typeof email !== "string") return null;
  // Sessions are bound to the door they were minted at (both directions).
  // Pre-binding sessions carry no claim and read as canonical — exactly what
  // they were.
  const mintedFor = (session.get("partner") as string | undefined) || null;
  if (mintedFor !== hostPartnerId) return null;
  return (await canSignInOnHost(email, hostPartnerId)) ? email : null;
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

/** Stamp a one-time Stripe Connect OAuth nonce on the admin session, bound to
 *  the property the operator started Connect for. Send `nonce` as OAuth `state`. */
export async function stampStripeConnectState(
  request: Request,
  propertyId: string,
): Promise<{ nonce: string; cookie: string }> {
  const nonce = generateConnectNonce();
  const storage = sessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  session.set(STRIPE_CONNECT_SESSION_KEY, { nonce, propertyId });
  return { nonce, cookie: await storage.commitSession(session) };
}

/** Consume Connect OAuth `state` against the session. Matching nonce is deleted
 *  (one-time) and the bound propertyId is returned. Missing, unknown, or reused
 *  state returns null and leaves the session unchanged. */
export async function consumeStripeConnectState(
  request: Request,
  state: string | null,
): Promise<{ propertyId: string; cookie: string } | null> {
  const storage = sessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  const pending = parseConnectPending(session.get(STRIPE_CONNECT_SESSION_KEY));
  const propertyId = matchConnectState(pending, state);
  if (!propertyId) return null;
  session.unset(STRIPE_CONNECT_SESSION_KEY);
  return { propertyId, cookie: await storage.commitSession(session) };
}

export async function logout(request: Request) {
  const storage = sessionStorage();
  const session = await storage.getSession(request.headers.get("Cookie"));
  return redirect("/admin/login", {
    headers: { "Set-Cookie": await storage.destroySession(session) },
  });
}

// ---------- email delivery ----------
/** Emails the magic link. Never returns it for on-screen display, and never
 *  logs the URL — Worker logs are treated as secret. A failed send is logged
 *  generically so ops can see delivery broke without leaking the token. */
export async function sendMagicLink(email: string, link: string): Promise<{ sent: boolean }> {
  // Sign-in is pre-property, so the brand comes from the USER: a hotel under a
  // white-label partner gets the partner's name, never ours; unknown emails
  // (open self-signup) get the default.
  const brand = await brandForUser(email);
  const { sent } = await sendEmail({
    to: email,
    subject: brand.partnerId ? `Sign in to ${brand.name}` : "Your admin sign-in link",
    html: `<p>Click to sign in to ${brand.partnerId ? brand.name : "the booking admin"}:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`,
    from: brand.emailFrom,
    replyTo: brand.supportEmail,
  });
  if (!sent) {
    console.log(`[admin] magic link email failed for ${email}`);
  }
  return { sent };
}
