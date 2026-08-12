// Stripe via the REST API over fetch (no SDK — matches the Channex/SparkPost
// pattern and avoids SDK/runtime issues on Workers). Stripe expects
// form-encoded bodies with bracket notation for nested params.
//
// Multi-tenant: each property connects its own Stripe account (Connect Standard,
// OAuth). Charges run as direct charges on the connected account by passing the
// `Stripe-Account` header. This module is the platform-side client.
import { getConfig } from "./config.server";
import { hmacSha256Hex, timingSafeEqual } from "./hmac.server";
import { roundStripeMinor } from "./money";

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
  country?: string | null;
  default_currency?: string | null;
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

/**
 * Locales Stripe's hosted Checkout accepts, verbatim from their API reference.
 *
 * An allowlist rather than passing our language straight through, because Stripe
 * REJECTS an unknown locale and the session never gets created — the guest simply
 * cannot pay. Every guest language we ship today happens to be on this list, but
 * adding one that isn't (Welsh is a live possibility for a hotel in Wales) would
 * otherwise break checkout for that property with no obvious cause.
 */
const STRIPE_LOCALES = new Set([
  "bg", "cs", "da", "de", "el", "en", "en-GB", "es", "es-419", "et", "fi", "fil",
  "fr", "fr-CA", "hr", "hu", "id", "it", "ja", "ko", "lt", "lv", "ms", "mt", "nb",
  "nl", "pl", "pt", "pt-BR", "ro", "ru", "sk", "sl", "sv", "th", "tr", "vi", "zh",
  "zh-HK", "zh-TW",
]);

/**
 * A guest language as a Stripe `locale`, or "auto" when Stripe has no such locale.
 *
 * "auto" is Stripe's default and means the BROWSER's language — which is why this
 * has to be passed explicitly: a guest reading the site in German on an
 * English-language browser was getting an English payment page.
 */
export function stripeLocale(lang: string): string {
  const l = (lang || "").trim();
  if (STRIPE_LOCALES.has(l)) return l;
  // Fall back from a region to its base language ("de-AT" -> "de") before giving up.
  const base = l.split("-")[0];
  return STRIPE_LOCALES.has(base) ? base : "auto";
}

/**
 * The platform's revenue share as a `payment_intent_data` fragment, spread into
 * every payment-mode Checkout Session. Centralised because a session built
 * without it charges the guest identically but collects zero platform fee —
 * exactly what happened when the v1 API grew its own session-building copy.
 */
export function platformFee(amountMinor: number, currency: string): { application_fee_amount?: number } {
  const feeBps = getConfig().stripePlatformFeeBps;
  return feeBps > 0 ? { application_fee_amount: roundStripeMinor((amountMinor * feeBps) / 10000, currency) } : {};
}

export interface CheckoutSessionSpec {
  /** Booking/voucher reference — becomes `client_reference_id`. */
  reference: string;
  email: string;
  /** Stamped on the session AND its payment/setup intent (webhooks read both). */
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  currency: string;
  mode: "payment" | "setup";
  /** payment mode: the amount collected today, in Stripe minor units. */
  amountMinor?: number;
  /** payment mode: line-item name/description shown on the hosted page. */
  productName?: string;
  productDescription?: string;
  /** payment mode: the PaymentIntent description (the Stripe-dashboard line). */
  paymentDescription?: string;
  /** Hosted-page language (see stripeLocale); omitted = Stripe's browser default. */
  locale?: string;
  /** custom_text.submit — the note under the pay button. */
  submitMessage?: string;
}

/**
 * The one place Checkout Session params are assembled. Owns the invariants a
 * hand-rolled copy can silently drop: the platform fee (see platformFee — the
 * v1 API's own copy collected none), the 60-minute expiry that must stay
 * inside the 3h pending-stash TTL (a payment completed after the stash lapses
 * charges the guest with no record left to finalize, so no booking and no
 * refund), and setup mode's explicit currency (required — no line items).
 * Callers supply only URLs, human copy, and money.
 */
export function buildCheckoutSessionParams(spec: CheckoutSessionSpec): Record<string, unknown> {
  const common = {
    client_reference_id: spec.reference,
    customer_email: spec.email,
    metadata: spec.metadata,
    ...(spec.locale ? { locale: spec.locale } : {}),
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    success_url: spec.successUrl,
    cancel_url: spec.cancelUrl,
    ...(spec.submitMessage ? { custom_text: { submit: { message: spec.submitMessage } } } : {}),
  };
  if (spec.mode === "setup") {
    // Guarantee card: collect a card without charging anything.
    return {
      ...common,
      mode: "setup",
      currency: spec.currency.toLowerCase(),
      setup_intent_data: { metadata: spec.metadata },
    };
  }
  const amountMinor = spec.amountMinor ?? 0;
  return {
    ...common,
    mode: "payment",
    payment_intent_data: {
      description: spec.paymentDescription,
      metadata: spec.metadata,
      ...platformFee(amountMinor, spec.currency),
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: spec.currency.toLowerCase(),
          unit_amount: amountMinor,
          product_data: { name: spec.productName, description: spec.productDescription },
        },
      },
    ],
  };
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

// ---------- Refunds (on the connected account) ----------
export interface StripeRefund {
  id: string;
  amount?: number; // minor units
  currency?: string;
  status?: string; // "succeeded" | "pending" | "failed" | "canceled"
}

/** Refund a payment intent on a connected account. Omit `amountMinor` for a full
 *  refund. The idempotency key guards against a double-refund on retry.
 *
 *  A partial `amountMinor` is in the currency's SMALLEST unit — derive it with
 *  `toStripeMinor(amount, currency)`, never `amount * 100`: that would refund a
 *  zero-decimal currency (JPY, KRW…) a hundred times over. */
export function createRefund(
  account: string,
  paymentIntentId: string,
  amountMinor?: number,
  idempotencyKey?: string,
): Promise<StripeRefund> {
  return stripeRequest<StripeRefund>("/v1/refunds", {
    account,
    idempotencyKey,
    body: { payment_intent: paymentIntentId, ...(amountMinor != null ? { amount: amountMinor } : {}) },
  });
}

// ---------- Webhook signature verification (Web Crypto, no SDK) ----------
const TOLERANCE_SECONDS = 300;

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
