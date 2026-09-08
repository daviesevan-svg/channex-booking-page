// 2C2P — the hosted payment page (Payment Token API v4.3), for properties in
// South-East Asia.
//
// Same shape as iyzico (iyzico.server.ts): per-property credentials, a payment
// token minted server-side, the guest sent to 2C2P's own page, and the result
// re-verified against their Payment Inquiry API before anything is booked. We
// never see a card.
//
// Transport: every request body is `{"payload": "<JWT>"}` where the JWT is
// HS256 over the request fields, keyed by the merchant's secret key; every
// success response is the same wrapper and its JWT is verified with the same
// key before it is believed. A request 2C2P can't even decode comes back as
// bare JSON with respCode/respDesc and no payload — handled in `call`.
//
// Amounts are DECIMAL numbers (1000.00), not minor units — the one place this
// differs from Stripe and Viva, so the conversion is one exported helper.
//
// Not implemented: refunds. 2C2P's Payment Action API is a separate product
// (RSA-OAEP JWE + PS256 JWS with a merchant-generated keypair and 2C2P's
// public certificate), which is a key-exchange the hotel would have to run
// before their first refund. Until that exists, refunds are issued in the 2C2P
// merchant portal — refunds.server.ts says so instead of pretending.
//
// WebCrypto rather than node:crypto: this runs on Workers.

import { displayFractionDigits } from "./money";

export class C2pError extends Error {
  constructor(
    message: string,
    /** 2C2P's respCode, when it gave one — the codes are stable, the
     *  descriptions are not. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "C2pError";
  }
}

export interface C2pConfig {
  /** Merchant ID as registered with 2C2P (their example: "JT01"). */
  merchantId: string;
  /** The merchant "SHA key" / secret key from the 2C2P merchant portal. */
  secretKey: string;
  /** true = sandbox-pgw.2c2p.com. */
  sandbox?: boolean;
}

export function c2pConfigured(c: C2pConfig | null | undefined): c is C2pConfig {
  return Boolean(c && c.merchantId && c.secretKey);
}

const apiBase = (sandbox: boolean | undefined) =>
  sandbox ? "https://sandbox-pgw.2c2p.com" : "https://pgw.2c2p.com";

/** 2C2P's own success code, for the token request, the inquiry and the payment
 *  itself. Everything else is "not money" as far as a booking is concerned:
 *  0001/2001 pending, 0003 cancelled, 2002 not found, 4xxx declined. */
export const C2P_SUCCESS = "0000";

/**
 * A decimal amount in the currency's display precision — "12.34", or "20000"
 * for ¥/₫/Rp. 2C2P takes the number itself (D 12,5), and its docs single out
 * IDR as zero-decimal, so the amount is rounded the way the page showed it
 * rather than blindly to two places.
 */
export function toC2pAmount(amount: number, currency: string): number {
  const scale = 10 ** displayFractionDigits(currency);
  return Math.round(amount * scale) / scale;
}

/** Locales 2C2P's payment page renders. Anything else falls back to English —
 *  a guest reading the site in German pays on an English page, which beats a
 *  rejected request. */
const C2P_LOCALES = new Set(["en", "th", "zh", "ja", "id", "ms", "vi", "km", "my", "lo"]);

export const c2pLocale = (lang: string | undefined): string => {
  const l = (lang || "").trim().toLowerCase();
  if (C2P_LOCALES.has(l)) return l;
  const base = l.split("-")[0];
  return C2P_LOCALES.has(base) ? base : "en";
};

// ---- JWT (HS256, compact serialization) ------------------------------------

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlText = (s: string): string => b64url(enc.encode(s));

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

/**
 * Sign request claims into a compact JWT. Exported for its unit test: the
 * signing input is `base64url(header).base64url(claims)` and the key is the
 * secret's UTF-8 bytes (2C2P's samples pass the hex-looking key straight to
 * the JWT library as a string — it is NOT hex-decoded first).
 */
export async function signC2pPayload(secret: string, claims: unknown): Promise<string> {
  const head = b64urlText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlText(JSON.stringify(claims));
  const input = `${head}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Verify a response JWT and return its claims. Throws on a bad signature: a
 * response we can't authenticate proves nothing, and this is what releases a
 * booking. `crypto.subtle.verify` does the constant-time compare.
 */
export async function verifyC2pPayload<T = Record<string, unknown>>(secret: string, jwt: string): Promise<T> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new C2pError("2C2P response is not a JWT");
  const [head, body, sig] = parts;
  let alg: string | undefined;
  try {
    alg = (JSON.parse(new TextDecoder().decode(fromB64url(head))) as { alg?: string }).alg;
  } catch {
    throw new C2pError("2C2P response JWT header is unreadable");
  }
  // Pin the algorithm: a token claiming "none" or an RSA alg must not reach the
  // HMAC verify with our secret as its "public key".
  if (alg !== "HS256") throw new C2pError(`2C2P response JWT uses ${alg ?? "no"} algorithm, expected HS256`);
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, ["verify"]),
    fromB64url(sig),
    enc.encode(`${head}.${body}`),
  );
  if (!ok) throw new C2pError("2C2P response signature does not match the secret key");
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
  } catch {
    throw new C2pError("2C2P response JWT body is unreadable");
  }
}

// ---- Transport -------------------------------------------------------------

interface C2pResponse {
  respCode?: string;
  respDesc?: string;
  [key: string]: unknown;
}

/**
 * POST `{payload: jwt}` and return the verified claims of the reply. Business
 * failures (wrong currency, duplicate invoice, no such transaction) come back
 * as a signed payload with a non-0000 respCode — those are RETURNED, because
 * "not found" is an answer the inquiry caller needs, not an exception. Only a
 * request 2C2P couldn't process at all (bad JWT, unknown merchant → bare JSON
 * with no payload) or a structural failure throws.
 */
async function call<T extends C2pResponse>(c: C2pConfig, path: string, claims: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(c.sandbox)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ payload: await signC2pPayload(c.secretKey, claims) }),
    });
  } catch (e) {
    throw new C2pError(`2C2P unreachable: ${e instanceof Error ? e.message : e}`);
  }
  const text = await res.text();
  let outer: { payload?: unknown; respCode?: unknown; respDesc?: unknown };
  try {
    outer = JSON.parse(text) as typeof outer;
  } catch {
    throw new C2pError(`2C2P returned ${res.status}: ${text.slice(0, 200)}`);
  }
  if (typeof outer.payload === "string") return verifyC2pPayload<T>(c.secretKey, outer.payload);
  // No payload: 2C2P rejected the envelope itself. Their code is the useful
  // part (the description is just "Invalid Request (code)"): 9042 is a JWT
  // that doesn't verify — a wrong secret key — and 9007 an unknown merchant.
  // Both confirmed against their sandbox, 2026-09-08.
  const code = typeof outer.respCode === "string" ? outer.respCode : undefined;
  const desc = typeof outer.respDesc === "string" ? outer.respDesc : `HTTP ${res.status}`;
  throw new C2pError(`2C2P rejected the request: ${desc}${code ? ` (${code})` : ""}`, code);
}

// ---- Payment Token ---------------------------------------------------------

export interface C2pPaymentSpec {
  /** Our booking reference — becomes invoiceNo, the key every later lookup
   *  uses. AN 50 at 2C2P; ours are far shorter. */
  invoiceNo: string;
  /** What the guest is paying for, on the payment page. C 250. */
  description: string;
  /** Major units, the property's currency. */
  amount: number;
  currency: string;
  /** Where the guest is sent after paying (GET/POST — we read nothing from it). */
  frontendReturnUrl: string;
  /** Where 2C2P posts the result server-to-server. */
  backendReturnUrl: string;
  lang?: string;
  guest?: { name?: string; email?: string; countryCode?: string };
}

export interface C2pPaymentInit {
  paymentToken: string;
  /** 2C2P's hosted page — where the guest is redirected. */
  webPaymentUrl: string;
}

/** Mint a payment token and get the hosted page URL. */
export async function createC2pPayment(c: C2pConfig, spec: C2pPaymentSpec): Promise<C2pPaymentInit> {
  const guest = spec.guest ?? {};
  const userInfo = {
    ...(guest.name ? { name: guest.name.slice(0, 50) } : {}),
    ...(guest.email ? { email: guest.email.slice(0, 150) } : {}),
    ...(guest.countryCode && /^[A-Za-z]{2}$/.test(guest.countryCode)
      ? { countryCode: guest.countryCode.toUpperCase() }
      : {}),
  };
  const res = await call<C2pResponse & { paymentToken?: unknown; webPaymentUrl?: unknown }>(
    c,
    "/payment/4.3/paymentToken",
    {
      merchantID: c.merchantId,
      invoiceNo: spec.invoiceNo,
      // 2C2P asks for HTML-encoding of special characters in the description;
      // dropping the five that matter is simpler than encoding and un-encoding.
      description: spec.description.replace(/[<>&"']/g, "").slice(0, 250),
      amount: toC2pAmount(spec.amount, spec.currency),
      currencyCode: spec.currency.toUpperCase(),
      frontendReturnUrl: spec.frontendReturnUrl,
      backendReturnUrl: spec.backendReturnUrl,
      locale: c2pLocale(spec.lang),
      // Our reference again, in a field the inquiry echoes back — belt and
      // braces beside invoiceNo.
      userDefined1: spec.invoiceNo,
      ...(Object.keys(userInfo).length ? { uiParams: { userInfo } } : {}),
    },
  );
  if (res.respCode !== C2P_SUCCESS || typeof res.webPaymentUrl !== "string" || typeof res.paymentToken !== "string") {
    throw new C2pError(res.respDesc || "2C2P refused the payment token", res.respCode);
  }
  return { paymentToken: res.paymentToken, webPaymentUrl: res.webPaymentUrl };
}

// ---- Payment Inquiry -------------------------------------------------------

export interface C2pInquiry {
  /** 0000 = paid. Anything else is not a payment (see C2P_SUCCESS). */
  respCode: string;
  respDesc: string;
  merchantId: string;
  invoiceNo: string;
  /** Decimal, as 2C2P reports it. */
  amount: number;
  /** ISO 4217 alpha. */
  currency: string;
  /** 2C2P's routing-system reference — the id a support ticket wants. */
  tranRef?: string;
  /** Acquirer's reference number. */
  referenceNo?: string;
  approvalCode?: string;
  /** Masked card: first 6 + last 4. */
  accountNo?: string;
  channelCode?: string;
  paymentScheme?: string;
  /** yyyyMMddHHmmss. */
  transactionDateTime?: string;
}

/**
 * What actually happened, asked of 2C2P rather than believed from a return
 * URL or a notification — both arrive on requests we did not make, and the
 * notification carries no per-property signature we could pin beyond the
 * shared secret. Looked up by OUR invoice number, so the answer can only ever
 * describe this booking's own payment.
 */
export async function inquireC2pPayment(c: C2pConfig, invoiceNo: string): Promise<C2pInquiry> {
  const r = await call<C2pResponse>(c, "/payment/4.3/paymentInquiry", {
    merchantID: c.merchantId,
    invoiceNo,
    locale: "en",
  });
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  return {
    respCode: str("respCode") ?? "",
    respDesc: str("respDesc") ?? "",
    merchantId: str("merchantID") ?? "",
    invoiceNo: str("invoiceNo") ?? "",
    amount: Number(r.amount ?? 0),
    currency: (str("currencyCode") ?? "").toUpperCase(),
    tranRef: str("tranRef"),
    referenceNo: str("referenceNo"),
    approvalCode: str("approvalCode"),
    accountNo: str("accountNo"),
    channelCode: str("channelCode"),
    paymentScheme: str("paymentScheme"),
    transactionDateTime: str("transactionDateTime"),
  };
}

/** Money actually taken. Pending (0001/2001), cancelled (0003), never started
 *  (2002 not found) and every decline are all "no" here. */
export function c2pPaid(r: C2pInquiry): boolean {
  return r.respCode === C2P_SUCCESS;
}

// ---- Save-time verification ------------------------------------------------

/**
 * Are these credentials usable, in this currency? Called when a hotel saves
 * them.
 *
 * Viva taught us this one (PR467): a credential that is merely stored fails for
 * the first time in front of a paying guest. So this mints a real payment token
 * for a tiny amount in the property's currency — never paid, expires on 2C2P's
 * side after their default 20 minutes — which exercises the merchant id, the
 * secret key (a wrong one is a bare 9042 with no payload) AND the currency (an
 * unsupported one is 5008). Returns null when fine, else the reason.
 */
export async function verifyC2pConfig(c: C2pConfig, currency: string): Promise<string | null> {
  try {
    // One whole unit: the smallest amount that is valid in every currency,
    // zero-decimal ones included.
    await createC2pPayment(c, {
      invoiceNo: `PROBE${Date.now().toString(36).toUpperCase()}`,
      description: "Connection check (never charged)",
      amount: 1,
      currency,
      frontendReturnUrl: "https://example.invalid/2c2p/return",
      backendReturnUrl: "https://example.invalid/2c2p/notify",
      lang: "en",
    });
    return null;
  } catch (e) {
    if (e instanceof C2pError) {
      if (e.code === "9042") return "2C2P rejected the signature — the secret key doesn't match this merchant (their code 9042). Check it against the merchant portal, and that sandbox/live matches the key.";
      if (e.code === "9007") return "2C2P doesn't know this merchant ID (their code 9007). Check it, and whether it belongs to the sandbox or to live.";
      if (e.code === "5008") return `2C2P doesn't accept ${currency.toUpperCase()} on this merchant account.`;
      return e.message;
    }
    return e instanceof Error ? e.message : "2C2P could not be reached";
  }
}
