// Viva.com Smart Checkout via the REST API over fetch (no SDK — same pattern as
// stripe.server.ts). Unlike Stripe Connect there is no OAuth: each property
// pastes its own Viva credentials (see VivaConfig), and every call here runs
// with that property's credentials against Viva's demo or live environment.
//
// The flow mirrors Stripe's hosted Checkout: create a payment order server-side,
// redirect the guest to Viva's hosted page, confirm via the return URL and/or
// the Transaction Payment Created webhook, and always re-verify the transaction
// with the Retrieve Transaction API before finalizing (Viva webhooks carry no
// signature — the API lookup IS the authentication).

export class VivaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "VivaError";
  }
}

/** Per-property Viva credentials, stored in their own KV key (never inside
 *  SiteSettings — settings objects travel into loader data, secrets must not). */
export interface VivaConfig {
  /** Merchant ID (a UUID) + API key — Basic-auth pair for the "old" API
   *  (refunds, webhook verification key). */
  merchantId: string;
  apiKey: string;
  /** Smart Checkout client credentials — OAuth2 pair for /checkout/v2. */
  clientId: string;
  clientSecret: string;
  /** 4-digit code of the payment source (website/app) orders are created for. */
  sourceCode: string;
  /** true = Viva's demo (sandbox) environment. */
  demo?: boolean;
}

/** A config is usable only when every credential is present. */
export function vivaConfigured(v: VivaConfig | null | undefined): v is VivaConfig {
  return Boolean(v && v.merchantId && v.apiKey && v.clientId && v.clientSecret && v.sourceCode);
}

const hosts = (demo: boolean | undefined) =>
  demo
    ? {
        accounts: "https://demo-accounts.vivapayments.com",
        api: "https://demo-api.vivapayments.com",
        www: "https://demo.vivapayments.com",
      }
    : {
        accounts: "https://accounts.vivapayments.com",
        api: "https://api.vivapayments.com",
        www: "https://www.vivapayments.com",
      };

/** The hosted payment page for an order — where the guest is redirected. */
export function vivaCheckoutUrl(v: VivaConfig, orderCode: string, brandColor?: string): string {
  const color = brandColor ? `&color=${brandColor.replace(/^#/, "")}` : "";
  return `${hosts(v.demo).www}/web/checkout?ref=${orderCode}${color}`;
}

/** Currencies Smart Checkout supports (per Viva's docs). A property whose
 *  currency isn't here can't charge through Viva at all — the admin page
 *  refuses the connection rather than letting checkout fail guest-by-guest. */
export const VIVA_CURRENCIES = new Set(["EUR", "GBP", "PLN", "CZK", "DKK", "SEK", "HUF", "RON"]);

/** ISO-4217 numeric → alpha for the currencies Viva can settle. The Retrieve
 *  Transaction API reports `currencyCode` numerically ("978"); the finalize
 *  tripwire compares alphabetic codes. */
const NUMERIC_CURRENCIES: Record<string, string> = {
  "978": "EUR",
  "826": "GBP",
  "985": "PLN",
  "203": "CZK",
  "208": "DKK",
  "752": "SEK",
  "348": "HUF",
  "946": "RON",
};
export function vivaAlphaCurrency(numeric: string | undefined): string | undefined {
  return numeric ? NUMERIC_CURRENCIES[numeric] : undefined;
}

// Viva amounts are in the currency's smallest unit, and every currency Viva
// supports has two decimals — a plain ×100 is exact here (no zero-decimal
// special cases like Stripe's JPY).
export const toVivaMinor = (amount: number): number => Math.round(amount * 100);
export const fromVivaMinor = (minor: number): number => Math.round(minor) / 100;

/** Smart Checkout page languages (requestLang), from Viva's supported list.
 *  Anything else falls back to English rather than sending an unknown tag. */
const VIVA_LANGS: Record<string, string> = {
  en: "en-GB",
  de: "de-DE",
  fr: "fr-FR",
  it: "it-IT",
  es: "es-ES",
  pl: "pl-PL",
  ro: "ro-RO",
  nl: "nl-NL",
  el: "el-GR",
  cs: "cs-CZ",
  pt: "pt-PT",
  sv: "sv-SE",
  hu: "hu-HU",
  bg: "bg-BG",
  da: "da-DK",
  fi: "fi-FI",
  hr: "hr-HR",
};
export function vivaRequestLang(lang: string | undefined): string {
  const base = (lang || "").trim().toLowerCase().split("-")[0];
  return VIVA_LANGS[base] ?? "en-GB";
}

// ---------- OAuth2 (Smart Checkout client credentials) ----------

/** Fetch a bearer token for the /checkout/v2 endpoints. Tokens last an hour;
 *  we fetch per operation (a checkout is one order + at most one retrieve) —
 *  caching across isolates isn't worth a KV round-trip. */
async function vivaToken(v: VivaConfig): Promise<string> {
  const res = await fetch(`${hosts(v.demo).accounts}/connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${v.clientId}:${v.clientSecret}`)}`,
    },
    body: "grant_type=client_credentials",
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !json.access_token) {
    throw new VivaError(res.status, `Viva token request failed (${res.status}) — check the Smart Checkout client credentials.`);
  }
  return json.access_token;
}

// ---------- Payment orders (Smart Checkout) ----------

export interface VivaOrderSpec {
  /** Amount to collect, in minor units (see toVivaMinor). */
  amountMinor: number;
  /** Shown to the guest on the hosted page ("what am I paying for"). */
  customerTrns: string;
  /** Our side of the description — the booking reference lives here so the
   *  webhook payload carries it even if the order-code mapping is gone. */
  merchantTrns: string;
  email: string;
  fullName: string;
  /** Guest language (our code, e.g. "de") — mapped to Viva's requestLang. */
  lang?: string;
  /** Seconds the order stays payable. Matches the Stripe session's 60 minutes
   *  so both stay inside the 3h pending-stash TTL. */
  timeoutSeconds?: number;
}

/** Create a payment order. Returns the order code (a 16-digit id) as a STRING —
 *  it exceeds MAX_SAFE_INTEGER territory, so it must never live as a JS number. */
export async function createVivaOrder(v: VivaConfig, spec: VivaOrderSpec): Promise<string> {
  const token = await vivaToken(v);
  const res = await fetch(`${hosts(v.demo).api}/checkout/v2/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: spec.amountMinor,
      customerTrns: spec.customerTrns,
      merchantTrns: spec.merchantTrns,
      sourceCode: v.sourceCode,
      paymentTimeout: spec.timeoutSeconds ?? 3600,
      customer: {
        email: spec.email,
        fullName: spec.fullName,
        requestLang: vivaRequestLang(spec.lang),
      },
    }),
  });
  // The raw text, not res.json(): a JSON parse would turn the 16-digit
  // orderCode into a lossy float. Pull the digits out of the body as text.
  const text = await res.text();
  if (!res.ok) throw new VivaError(res.status, `Viva order creation failed (${res.status}): ${text.slice(0, 300)}`);
  const code = extractOrderCode(text);
  if (!code) throw new VivaError(502, `Viva order response carried no orderCode: ${text.slice(0, 300)}`);
  return code;
}

export interface VivaTransaction {
  /** "F" = finished (paid). Anything else is not a completed payment. */
  statusId?: string;
  /** In MAJOR units (e.g. 125.5), unlike order creation. */
  amount?: number;
  orderCode?: number | string;
  /** ISO-4217 numeric, e.g. "978" for EUR. */
  currencyCode?: string;
  email?: string;
  fullName?: string;
  cardNumber?: string;
  merchantTrns?: string;
}

/** Retrieve a transaction by id — the authoritative payment check for both the
 *  return URL and the webhook. */
export async function retrieveVivaTransaction(v: VivaConfig, transactionId: string): Promise<VivaTransaction> {
  const token = await vivaToken(v);
  const res = await fetch(`${hosts(v.demo).api}/checkout/v2/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new VivaError(res.status, `Viva transaction lookup failed (${res.status}).`);
  let json: VivaTransaction;
  try {
    json = JSON.parse(text) as VivaTransaction;
  } catch {
    throw new VivaError(502, "Viva transaction lookup returned malformed JSON.");
  }
  // Re-read the orderCode from the raw text: it's a 16-digit JSON number, which
  // JSON.parse can round above MAX_SAFE_INTEGER — and a rounded code would fail
  // the order-match check on a genuinely paid booking.
  const oc = extractOrderCode(text);
  if (oc) json.orderCode = oc;
  return json;
}

/** The orderCode digits from a raw Viva JSON body, without a float round-trip. */
export function extractOrderCode(rawJson: string): string | null {
  const m = rawJson.match(/"orderCode"\s*:\s*"?(\d+)"?/i);
  return m ? m[1] : null;
}

// ---------- Old API (Basic auth: merchantId:apiKey) ----------

const basicAuth = (v: VivaConfig) => `Basic ${btoa(`${v.merchantId}:${v.apiKey}`)}`;

export interface VivaRefundResult {
  TransactionId?: string;
  Amount?: number; // major units
  StatusId?: string; // "F" = finished
  Success?: boolean;
  ErrorText?: string | null;
}

/** Refund (or same-day cancel) a card transaction, fully or partially.
 *  `amountMinor` is in the currency's smallest unit. Requires "Allow refunds"
 *  ticked under Settings → API Access in the property's Viva account. */
export async function vivaRefund(v: VivaConfig, transactionId: string, amountMinor: number): Promise<VivaRefundResult> {
  const url = `${hosts(v.demo).www}/api/transactions/${encodeURIComponent(transactionId)}?amount=${amountMinor}&sourceCode=${encodeURIComponent(v.sourceCode)}`;
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: basicAuth(v) } });
  const json = (await res.json().catch(() => ({}))) as VivaRefundResult;
  if (!res.ok || json.Success === false || (json.StatusId && json.StatusId !== "F")) {
    throw new VivaError(res.status, `Viva refund failed (${res.status}): ${json.ErrorText ?? "no detail"}`);
  }
  return json;
}

/** The merchant's webhook verification key. Viva GETs our webhook URL when the
 *  operator saves it in their banking app, and expects this key echoed back as
 *  `{"Key": "..."}` — that round-trip is how Viva verifies the endpoint. */
export async function retrieveVivaWebhookKey(v: VivaConfig): Promise<string> {
  const res = await fetch(`${hosts(v.demo).www}/api/messages/config/token`, {
    headers: { Authorization: basicAuth(v) },
  });
  const json = (await res.json().catch(() => ({}))) as { Key?: string };
  if (!res.ok || !json.Key) {
    throw new VivaError(res.status, `Viva webhook-key request failed (${res.status}) — check the Merchant ID and API key.`);
  }
  return json.Key;
}

/** Validate a pasted config by exercising BOTH credential pairs against Viva:
 *  the OAuth pair (token) and the Basic pair (webhook key). Returns the error
 *  message to show the operator, or null when both check out. */
export async function verifyVivaConfig(v: VivaConfig): Promise<string | null> {
  try {
    await vivaToken(v);
  } catch (e) {
    return e instanceof Error ? e.message : "The Smart Checkout client credentials were rejected.";
  }
  try {
    await retrieveVivaWebhookKey(v);
  } catch (e) {
    return e instanceof Error ? e.message : "The Merchant ID / API key pair was rejected.";
  }
  return null;
}

/** EventTypeId of the "Transaction Payment Created" webhook. */
export const VIVA_EVENT_PAYMENT_CREATED = 1796;
