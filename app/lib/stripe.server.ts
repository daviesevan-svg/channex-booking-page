// Stripe via the REST API over fetch (no SDK — matches the Channex/SparkPost
// pattern and avoids SDK/runtime issues on Workers). Stripe expects
// form-encoded bodies with bracket notation for nested params.
//
// Multi-tenant: each property connects its own Stripe account (Connect Standard,
// OAuth). Charges run as direct charges on the connected account by passing the
// `Stripe-Account` header. This module is the platform-side client.
import { getConfig } from "./config.server";

const API_BASE = "https://api.stripe.com";
const CONNECT_BASE = "https://connect.stripe.com";

export class StripeError extends Error {
  constructor(
    public status: number,
    public type: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** Flatten a nested object/array into Stripe's `a[b][c]=v` form encoding. */
export function toForm(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v != null && typeof v === "object") toForm(v as Record<string, unknown>, `${k}[${i}]`, out);
        else out.append(`${k}[${i}]`, String(v));
      });
    } else if (typeof value === "object") {
      toForm(value as Record<string, unknown>, k, out);
    } else {
      out.append(k, String(value));
    }
  }
  return out;
}

interface StripeRequestOpts {
  method?: "GET" | "POST";
  /** Connected account id (acct_…) for direct charges / account-scoped calls. */
  account?: string;
  /** Idempotency key for safe retries on POST. */
  idempotencyKey?: string;
  body?: Record<string, unknown>;
  /** Override the API key (e.g. the platform key for OAuth token exchange). */
  apiKey?: string;
  /** Override the base URL (e.g. connect.stripe.com for OAuth). */
  base?: string;
}

async function stripeRequest<T>(path: string, opts: StripeRequestOpts = {}): Promise<T> {
  const { stripeSecretKey } = getConfig();
  const apiKey = opts.apiKey ?? stripeSecretKey;
  if (!apiKey) throw new StripeError(500, "config", "Stripe is not configured (STRIPE_SECRET_KEY missing).");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (opts.account) headers["Stripe-Account"] = opts.account;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const res = await fetch(`${opts.base ?? API_BASE}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ? toForm(opts.body).toString() : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
  if (!res.ok || json.error) {
    throw new StripeError(res.status, json.error?.type, json.error?.message ?? `Stripe responded ${res.status}`);
  }
  return json as T;
}

// ---------- Connect (Standard) OAuth ----------
export interface StripeOAuthToken {
  stripe_user_id: string; // acct_…
  scope?: string;
  livemode?: boolean;
}

/** The hosted authorize URL the operator is sent to, to connect their account. */
export function oauthAuthorizeUrl(state: string, redirectUri: string): string {
  const { stripeConnectClientId } = getConfig();
  const p = new URLSearchParams({
    response_type: "code",
    client_id: stripeConnectClientId ?? "",
    scope: "read_write",
    redirect_uri: redirectUri,
    state,
  });
  return `${CONNECT_BASE}/oauth/authorize?${p.toString()}`;
}

/** Exchange an OAuth authorization code for the connected account id. */
export function oauthToken(code: string): Promise<StripeOAuthToken> {
  return stripeRequest<StripeOAuthToken>("/oauth/token", {
    base: CONNECT_BASE,
    body: { grant_type: "authorization_code", code },
  });
}

/** Revoke our access to a connected account. */
export function deauthorize(account: string): Promise<unknown> {
  const { stripeConnectClientId } = getConfig();
  return stripeRequest("/oauth/deauthorize", {
    base: CONNECT_BASE,
    body: { client_id: stripeConnectClientId, stripe_user_id: account },
  });
}

export interface StripeAccount {
  id: string;
  charges_enabled?: boolean;
  details_submitted?: boolean;
  business_profile?: { name?: string | null } | null;
  email?: string | null;
}

export function retrieveAccount(account: string): Promise<StripeAccount> {
  return stripeRequest<StripeAccount>(`/v1/accounts/${account}`, { method: "GET" });
}

// ---------- Checkout Sessions (direct charges on the connected account) ----------
export interface StripePaymentMethod {
  id: string;
  card?: { brand?: string; last4?: string };
}
export interface CheckoutSession {
  id: string;
  url?: string;
  payment_status?: string; // "paid" | "unpaid" | "no_payment_required"
  status?: string; // "open" | "complete" | "expired"
  mode?: string;
  amount_total?: number;
  currency?: string;
  payment_intent?: string | { id: string };
  setup_intent?: string | { id: string; payment_method?: string | StripePaymentMethod };
  customer?: string | { id: string };
}

/** Create a Checkout Session on a connected account. `params` is passed through
 *  to Stripe form-encoded, so nested objects/arrays use the documented shape. */
export function createCheckoutSession(
  account: string,
  params: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<CheckoutSession> {
  return stripeRequest<CheckoutSession>("/v1/checkout/sessions", { account, body: params, idempotencyKey });
}

export function retrieveCheckoutSession(account: string, id: string): Promise<CheckoutSession> {
  return stripeRequest<CheckoutSession>(
    `/v1/checkout/sessions/${id}?expand[]=payment_intent&expand[]=setup_intent&expand[]=setup_intent.payment_method`,
    { method: "GET", account },
  );
}

// ---------- Webhook signature verification (Web Crypto, no SDK) ----------
const TOLERANCE_SECONDS = 300;

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a Stripe-Signature header and return the parsed event, or throw. */
export async function verifyWebhook(rawBody: string, sigHeader: string | null, secret: string, nowSec: number): Promise<unknown> {
  if (!sigHeader || !secret) throw new StripeError(400, "signature", "Missing signature or secret.");
  const parts = Object.fromEntries(sigHeader.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) throw new StripeError(400, "signature", "Malformed signature header.");
  if (Math.abs(nowSec - t) > TOLERANCE_SECONDS) throw new StripeError(400, "signature", "Timestamp outside tolerance.");
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  if (!timingSafeEqual(expected, v1)) throw new StripeError(400, "signature", "Signature mismatch.");
  return JSON.parse(rawBody);
}
