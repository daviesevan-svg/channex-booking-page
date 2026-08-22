// Web-checkout book-intent identity. POST /v1/bookings takes a client
// Idempotency-Key; the hosted form has none, and used to mint a fresh
// generateReference() on every submit. Two clicks → two pending bookings →
// two Stripe sessions (or two uncarded finalizes).
//
// The key is a hash of the stay + guest + cart, not a page-load nonce: a
// refresh-and-resubmit of the same stay is the same intent. The reference
// itself stays random (it's the manage-booking credential).

export interface CheckoutIntentParts {
  pid: string;
  checkin: string;
  checkout: string;
  currency: string;
  adults: number;
  childrenAge: number[];
  /** serializeCart(parseCart(url)) — room/rate/occupancy, not titles. */
  cart: string;
  /** serializeExtrasState(parseExtrasState(url)). */
  extras: string;
  promo: string;
  voucher: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
}

/** Canonical JSON for a book intent. Amounts are deliberately omitted — a
 *  resubmit must reuse the first pending/session, not open a second stay at a
 *  later catalogue price. Arrival notes and marketing opt-in are omitted too
 *  (they are not the stay). */
export function canonicalCheckoutIntent(p: CheckoutIntentParts): string {
  return JSON.stringify({
    pid: p.pid,
    checkin: p.checkin,
    checkout: p.checkout,
    currency: p.currency,
    adults: p.adults,
    childrenAge: p.childrenAge,
    cart: p.cart,
    extras: p.extras,
    promo: p.promo,
    voucher: p.voucher,
    email: p.email.trim().toLowerCase(),
    firstName: p.firstName.trim(),
    lastName: p.lastName.trim(),
    phone: p.phone.trim(),
  });
}

export async function hashCheckoutIntent(canonical: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cached outcome of a web book intent, stored under `idem:web:${pid}:${hash}`
 *  the same way POST /v1/bookings caches `{ status, body }` under `idem:`. */
export type WebCheckoutCached =
  | { kind: "payment"; reference: string; url: string }
  | { kind: "confirmed"; reference: string };

export type WebCheckoutReplay =
  | { kind: "payment"; url: string }
  | { kind: "confirmed"; reference: string };

/** Pure replay decision. First finished submit wins; a cancelled/failed
 *  booking is not reused so the guest can try again. */
export function decideWebCheckoutReplay(input: {
  cached: WebCheckoutCached | null;
  booking: { status: string; lifecycle?: string; reference: string } | null;
  paymentUrl: string | null;
}): WebCheckoutReplay | null {
  if (input.cached?.kind === "payment" && input.cached.url) {
    return { kind: "payment", url: input.cached.url };
  }
  // A cancelled/failed booking must not be replayed — even if the KV cache
  // still says "confirmed" — so the guest can submit the same stay again.
  if (input.booking && (input.booking.lifecycle === "cancelled" || input.booking.status === "failed")) {
    return null;
  }
  if (input.cached?.kind === "confirmed") {
    return { kind: "confirmed", reference: input.cached.reference };
  }
  if (input.booking && input.booking.status !== "failed") {
    return { kind: "confirmed", reference: input.booking.reference };
  }
  if (input.paymentUrl) return { kind: "payment", url: input.paymentUrl };
  return null;
}
