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
