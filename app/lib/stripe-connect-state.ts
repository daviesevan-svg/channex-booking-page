// Stripe Connect OAuth `state` — a one-time nonce bound to a property in the
// admin session. The property UUID is not secret (DEFAULT_PROPERTY_ID lives in
// wrangler.jsonc; the Viva webhook URL shows it in admin), so it must never be
// sent as `state`. SameSite=Lax sends the session cookie on the top-level GET
// callback; a client-supplied UUID would let a logged-in admin be lured into
// attaching an attacker's Stripe account (guest charges then land on the attacker).
import { timingSafeEqual } from "./hmac.server";

export const STRIPE_CONNECT_SESSION_KEY = "stripeConnect";

export type StripeConnectPending = {
  nonce: string;
  propertyId: string;
};

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 256-bit unguessable nonce. Not a UUID — property ids are UUIDs. */
export function generateConnectNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function parseConnectPending(value: unknown): StripeConnectPending | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.nonce !== "string" || typeof rec.propertyId !== "string") return null;
  if (!rec.nonce || !rec.propertyId) return null;
  return { nonce: rec.nonce, propertyId: rec.propertyId };
}

/** Bind the OAuth `state` query param to the session pending. Returns the
 *  property the admin started Connect for, or null for missing / unknown /
 *  mismatched state. Does not consume — the session helper deletes on match. */
export function matchConnectState(pending: StripeConnectPending | null, state: string | null): string | null {
  if (!state || !pending) return null;
  if (!timingSafeEqual(pending.nonce, state)) return null;
  return pending.propertyId;
}

// ---------- partner-host round trip ----------
// Stripe only redirects to URIs registered on OUR platform account, so the
// callback always lands on the canonical host (APP_URL). A white-label
// partner's admin domain is not, and cannot practically be, registered there —
// yet that is where the admin's session, and the nonce inside it, live. So
// `state` carries the origin the admin started from, and the canonical callback
// hands Stripe's answer on to that origin's callback, which then checks the
// bare nonce against its own session exactly as before.
//
// Format: `<nonce>` on the canonical host, `<nonce>.<base64url(origin)>` off
// it. The nonce is base64url and never contains a dot, so the first dot splits.

const STATE_ORIGIN_SEPARATOR = ".";

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  try {
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** An origin the canonical callback may hand Stripe's answer to: exactly an
 *  http(s) origin — no path, query, fragment or credentials. Whether that host
 *  actually serves an admin of ours is the caller's check (a KV lookup). */
export function parseReturnOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.origin !== value) return null;
  return url.origin;
}

/** The `state` query param to send Stripe. `returnOrigin` is set only when the
 *  admin is not on the canonical host. */
export function encodeConnectState(nonce: string, returnOrigin?: string): string {
  if (!returnOrigin) return nonce;
  const origin = parseReturnOrigin(returnOrigin);
  if (!origin) throw new Error("returnOrigin must be a bare http(s) origin");
  return `${nonce}${STATE_ORIGIN_SEPARATOR}${toBase64Url(new TextEncoder().encode(origin))}`;
}

/** Split the `state` Stripe sent back. A bare nonce decodes to itself with no
 *  origin; a malformed origin suffix is null, never a nonce with a guess. */
export function decodeConnectState(state: string | null): { nonce: string; returnOrigin: string | null } | null {
  if (!state) return null;
  const i = state.indexOf(STATE_ORIGIN_SEPARATOR);
  if (i < 0) return { nonce: state, returnOrigin: null };
  const nonce = state.slice(0, i);
  const bytes = fromBase64Url(state.slice(i + 1));
  if (!nonce || !bytes) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const returnOrigin = parseReturnOrigin(decoded);
  if (!returnOrigin) return null;
  return { nonce, returnOrigin };
}
