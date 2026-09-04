// iyzico — the hosted Checkout Form, for Turkish properties.
//
// Same shape as Viva (viva.server.ts): per-property credentials, an order
// created server-side, the guest sent to the provider's own payment page, and
// the result re-verified against their API on return. We never see a card.
//
// The one genuinely fiddly part is the request signature, and it is fiddly in
// the way that fails silently — a wrong byte gets a flat 401 with no hint which
// component was wrong. Two different HMACs are involved and they are not the
// same construction:
//
//   REQUEST   IYZWSv2. HMAC-SHA256 of `randomKey + uriPath + body`, hex, then
//             `apiKey:…&randomKey:…&signature:…` base64'd into the header.
//   RESPONSE  iyzico signs its own reply: HMAC-SHA256 of specific response
//             fields joined by ":", hex. Different field list per endpoint, and
//             the amounts must have trailing zeros stripped first ("10.50" is
//             signed as "10.5"). Verified because this is what releases a
//             booking — see verifyRetrieveSignature.
//
// WebCrypto rather than node:crypto: this runs on Workers.

export class IyzicoError extends Error {
  constructor(
    message: string,
    /** iyzico's own error code, when it gave one — worth logging, since their
     *  messages are localised and the codes are not. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "IyzicoError";
  }
}

export interface IyzicoConfig {
  apiKey: string;
  secretKey: string;
  /** true = sandbox-api.iyzipay.com and the sandbox payment page. */
  sandbox?: boolean;
  /** Merchant id. Not needed for the Checkout Form calls — kept because iyzico
   *  support asks for it and a hotel that has it should not have to go looking
   *  again. */
  merchantId?: string;
}

export function iyzicoConfigured(c: IyzicoConfig | null | undefined): c is IyzicoConfig {
  return Boolean(c && c.apiKey && c.secretKey);
}

const apiBase = (sandbox: boolean | undefined) =>
  sandbox ? "https://sandbox-api.iyzipay.com" : "https://api.iyzipay.com";

/**
 * Currencies the Checkout Form accepts. All two-decimal, which is why nothing
 * here carries the zero-decimal minor-unit handling Stripe needs — if iyzico
 * ever adds JPY or KRW this becomes wrong, so the set is the guard.
 */
export const IYZICO_CURRENCIES = new Set(["TRY", "USD", "EUR", "GBP", "NOK", "CHF"]);

/** iyzico takes decimal strings, not minor units. */
export const toIyzicoAmount = (amount: number): string => (Math.round(amount * 100) / 100).toFixed(2);

/**
 * What iyzico signs its responses with: the same number without trailing
 * zeros. Their docs are explicit that the merchant has to do this — "10.50"
 * hashes as "10.5" and "10.00" as "10", and getting it wrong rejects a payment
 * that actually succeeded.
 */
export function signatureAmount(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * What goes in the buyer's `identityNumber`.
 *
 * iyzico's API requires the field — it is a Turkish national ID (TC Kimlik) —
 * and a hotel booking has no business collecting one: most guests are not
 * Turkish residents and would have nothing to give, and for those who are it is
 * a sensitive identifier we would then be storing for no purpose of our own.
 *
 * So every booking sends the filler iyzico's own sample code uses. Decided with
 * Evan, Sep 2026, and worth confirming with the merchant: if their account is
 * configured to expect real numbers, iyzico's fraud scoring is where it will
 * show up, not as a rejected request.
 */
export const IYZICO_PLACEHOLDER_IDENTITY = "11111111111";

/** tr for Turkish guests, en for everyone else — the only two iyzico has. */
export const iyzicoLocale = (lang: string | undefined): "tr" | "en" => (lang === "tr" ? "tr" : "en");

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** IYZWSv2. Exported for its unit test: this is the piece where a silent
 *  mistake costs an afternoon of 401s. */
export async function authorizationHeader(
  c: IyzicoConfig,
  uriPath: string,
  body: string | undefined,
  randomKey: string,
): Promise<string> {
  const signature = await hmacHex(c.secretKey, randomKey + uriPath + (body ?? ""));
  return `IYZWSv2 ${b64(`apiKey:${c.apiKey}&randomKey:${randomKey}&signature:${signature}`)}`;
}

const randomKey = () => `${Date.now()}${Math.floor(Math.random() * 1e9)}`;

interface IyzicoResponse {
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

async function call<T extends IyzicoResponse>(c: IyzicoConfig, uriPath: string, body: unknown): Promise<T> {
  const json = JSON.stringify(body);
  const rnd = randomKey();
  let res: Response;
  try {
    res = await fetch(apiBase(c.sandbox) + uriPath, {
      method: "POST",
      headers: {
        Authorization: await authorizationHeader(c, uriPath, json, rnd),
        "x-iyzi-rnd": rnd,
        "Content-Type": "application/json",
      },
      body: json,
    });
  } catch (e) {
    throw new IyzicoError(`iyzico unreachable: ${e instanceof Error ? e.message : e}`);
  }
  const text = await res.text();
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    // iyzico answers 200 with JSON even for business failures, so a body we
    // can't parse means something structural (a proxy, an outage) and the raw
    // text is the only clue worth keeping.
    throw new IyzicoError(`iyzico returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return parsed;
}

export interface IyzicoBasketItem {
  id: string;
  name: string;
  price: number;
}

export interface IyzicoFormSpec {
  /** Our booking reference — comes back on the retrieve as conversationId, and
   *  is how a callback is tied to a booking. */
  reference: string;
  amount: number;
  currency: string;
  /** Where iyzico sends the guest (and its IPN) after payment. */
  callbackUrl: string;
  lang?: string;
  buyer: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    /** The guest's IP, for iyzico's fraud scoring. */
    ip?: string;
    city?: string;
    country?: string;
    address?: string;
  };
  /** The rooms. Their prices MUST sum to `amount` — see below. */
  items: IyzicoBasketItem[];
  /** Turkish national ID for the buyer. iyzico's API requires the field; what
   *  goes in it is a business decision, so the caller supplies it rather than
   *  this module inventing one. */
  identityNumber: string;
}

export interface IyzicoFormInit {
  token: string;
  /** iyzico's hosted page — where the guest is redirected. */
  paymentPageUrl: string;
}

/**
 * Open a Checkout Form and get the hosted page URL.
 *
 * `price` is the basket total and `paidPrice` is what is charged; they are
 * equal for us, because we add no installment fee. iyzico rejects the request
 * outright if `price` is not exactly the sum of the basket items, so the total
 * is derived from the items rather than passed alongside them — the two can
 * then never disagree.
 */
export async function initializeCheckoutForm(c: IyzicoConfig, spec: IyzicoFormSpec): Promise<IyzicoFormInit> {
  if (!IYZICO_CURRENCIES.has(spec.currency.toUpperCase())) {
    throw new IyzicoError(`iyzico does not accept ${spec.currency}`);
  }
  const itemsTotal = spec.items.reduce((n, i) => n + i.price, 0);
  const price = toIyzicoAmount(itemsTotal);
  // A rounding difference between the stay total and the sum of its rooms is
  // ours to reconcile before we ask for money, not iyzico's to reject.
  if (toIyzicoAmount(spec.amount) !== price) {
    throw new IyzicoError(`basket items total ${price} but the booking is ${toIyzicoAmount(spec.amount)}`);
  }

  const address = spec.buyer.address || "-";
  const city = spec.buyer.city || "-";
  const country = spec.buyer.country || "Turkey";
  const contactName = `${spec.buyer.firstName} ${spec.buyer.lastName}`.trim() || "Guest";

  const res = await call(c, "/payment/iyzipos/checkoutform/initialize/auth/ecom", {
    locale: iyzicoLocale(spec.lang),
    conversationId: spec.reference,
    price,
    paidPrice: price,
    currency: spec.currency.toUpperCase(),
    basketId: spec.reference,
    paymentGroup: "PRODUCT",
    callbackUrl: spec.callbackUrl,
    enabledInstallments: [1],
    buyer: {
      id: spec.reference,
      name: spec.buyer.firstName || "Guest",
      surname: spec.buyer.lastName || "-",
      gsmNumber: spec.buyer.phone || undefined,
      email: spec.buyer.email,
      identityNumber: spec.identityNumber,
      registrationAddress: address,
      city,
      country,
      ip: spec.buyer.ip || undefined,
    },
    billingAddress: { contactName, city, country, address },
    // A hotel stay is not shipped. VIRTUAL keeps iyzico from expecting a
    // shipping address and from applying physical-goods fraud rules.
    basketItems: spec.items.map((i) => ({
      id: i.id,
      name: i.name.slice(0, 200),
      category1: "Accommodation",
      itemType: "VIRTUAL",
      price: toIyzicoAmount(i.price),
    })),
  });

  if (res.status !== "success" || typeof res.token !== "string" || typeof res.paymentPageUrl !== "string") {
    throw new IyzicoError(res.errorMessage || "iyzico refused the payment form", res.errorCode);
  }
  return { token: res.token, paymentPageUrl: res.paymentPageUrl };
}

export interface IyzicoPaymentResult {
  /** iyzico's own payment id — what a refund is issued against. */
  paymentId: string;
  /** "SUCCESS" once the money is taken. */
  paymentStatus: string;
  paidPrice: number;
  currency: string;
  /** Our booking reference, echoed back. */
  conversationId: string;
  basketId: string;
  /** -1 rejected, 0 under review, 1 approved. */
  fraudStatus?: number;
  /** True when the response carried a signature and it matched. */
  signatureVerified: boolean;
}

/** The retrieve response's own signature: these fields, in this order, joined
 *  by ":" — see the header. */
async function verifyRetrieveSignature(c: IyzicoConfig, r: IyzicoResponse): Promise<boolean> {
  const signature = typeof r.signature === "string" ? r.signature : "";
  if (!signature) return false;
  const parts = [
    String(r.paymentStatus ?? ""),
    String(r.paymentId ?? ""),
    String(r.currency ?? ""),
    String(r.basketId ?? ""),
    String(r.conversationId ?? ""),
    signatureAmount(r.paidPrice as string | number),
    signatureAmount(r.price as string | number),
    String(r.token ?? ""),
  ];
  return (await hmacHex(c.secretKey, parts.join(":"))) === signature;
}

/**
 * What actually happened, asked of iyzico rather than believed from the
 * callback.
 *
 * The token arrives on a request we did not make — iyzico posts it to our
 * callback, and anyone can post to that URL. So the token is treated purely as
 * a lookup key: everything the booking is finalized against comes from this
 * response, and the caller still has to check the amount, the currency and the
 * reference against the booking before releasing anything.
 */
export async function retrieveCheckoutForm(c: IyzicoConfig, token: string): Promise<IyzicoPaymentResult> {
  const res = await call(c, "/payment/iyzipos/checkoutform/auth/ecom/detail", { locale: "en", token });
  if (res.status !== "success") {
    throw new IyzicoError(res.errorMessage || "iyzico has no payment for that token", res.errorCode);
  }
  return {
    paymentId: String(res.paymentId ?? ""),
    paymentStatus: String(res.paymentStatus ?? ""),
    paidPrice: Number(res.paidPrice ?? 0),
    currency: String(res.currency ?? ""),
    conversationId: String(res.conversationId ?? ""),
    basketId: String(res.basketId ?? ""),
    fraudStatus: typeof res.fraudStatus === "number" ? res.fraudStatus : undefined,
    signatureVerified: await verifyRetrieveSignature(c, res),
  };
}

/** Money actually taken, and not held for a fraud review. `fraudStatus` 0 means
 *  iyzico is still deciding — treating that as paid would confirm a booking
 *  against money that can still be pulled back. */
export function iyzicoPaid(r: IyzicoPaymentResult): boolean {
  return r.paymentStatus.toUpperCase() === "SUCCESS" && r.fraudStatus !== -1 && r.fraudStatus !== 0;
}

export interface IyzicoRefundResult {
  refunded: boolean;
  message?: string;
}

export async function iyzicoRefund(
  c: IyzicoConfig,
  paymentId: string,
  amount: number,
  currency: string,
  ip?: string,
): Promise<IyzicoRefundResult> {
  const res = await call(c, "/payment/refund", {
    locale: "en",
    conversationId: paymentId,
    paymentTransactionId: paymentId,
    price: toIyzicoAmount(amount),
    currency: currency.toUpperCase(),
    ip: ip || undefined,
  });
  return res.status === "success"
    ? { refunded: true }
    : { refunded: false, message: res.errorMessage || "iyzico refused the refund" };
}

/**
 * Are these credentials usable? Called when a hotel saves them.
 *
 * Viva taught us this one: a credential that is merely stored, never exercised,
 * fails for the first time in front of a paying guest (PR467 — a bad source
 * code 500'd an empty page at checkout). A cheap authenticated call at save
 * time turns that into a form error. Returns null when fine, else the reason.
 */
export async function verifyIyzicoConfig(c: IyzicoConfig): Promise<string | null> {
  try {
    const res = await call(c, "/payment/bin/check", { locale: "en", binNumber: "552879" });
    if (res.status === "success") return null;
    // iyzico's auth failures come back as a business error, not a 401.
    return res.errorMessage || `iyzico rejected the credentials (${res.errorCode ?? "no code"})`;
  } catch (e) {
    return e instanceof Error ? e.message : "iyzico could not be reached";
  }
}
