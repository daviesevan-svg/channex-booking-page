import { describe, expect, it } from "vitest";

import {
  canonicalCheckoutIntent,
  decideWebCheckoutReplay,
  hashCheckoutIntent,
  type CheckoutIntentParts,
} from "./checkout-idem";

const stay = (over: Partial<CheckoutIntentParts> = {}): CheckoutIntentParts => ({
  pid: "prop-1",
  checkin: "2026-09-01",
  checkout: "2026-09-03",
  currency: "GBP",
  adults: 2,
  childrenAge: [4],
  cart: "room-a:rate-b:2",
  extras: "",
  promo: "",
  voucher: "",
  email: "jamie@email.com",
  firstName: "Jamie",
  lastName: "Doyle",
  phone: "+44 20 0000",
  ...over,
});

describe("canonicalCheckoutIntent", () => {
  it("is stable for the same stay and guest, ignoring email case and padding", () => {
    const a = canonicalCheckoutIntent(stay({ email: "Jamie@Email.com", firstName: " Jamie " }));
    const b = canonicalCheckoutIntent(stay({ email: "jamie@email.com", firstName: "Jamie" }));
    expect(a).toBe(b);
  });

  it("changes when the guest, cart, extras, promo, or voucher change", () => {
    const base = canonicalCheckoutIntent(stay());
    expect(canonicalCheckoutIntent(stay({ email: "other@email.com" }))).not.toBe(base);
    expect(canonicalCheckoutIntent(stay({ cart: "room-a:rate-b:2,room-c:rate-d:2" }))).not.toBe(base);
    expect(canonicalCheckoutIntent(stay({ extras: '{"l":[[{"id":"x"}]]}' }))).not.toBe(base);
    expect(canonicalCheckoutIntent(stay({ promo: "SUMMER10" }))).not.toBe(base);
    expect(canonicalCheckoutIntent(stay({ voucher: "RP-AAAA-BBBB" }))).not.toBe(base);
    expect(canonicalCheckoutIntent(stay({ checkin: "2026-09-02" }))).not.toBe(base);
  });

  it("does not include a payable amount — resubmits reuse the first pending, they do not re-price", () => {
    expect(canonicalCheckoutIntent(stay())).not.toMatch(/due|total|amount|grand/i);
  });
});

describe("hashCheckoutIntent", () => {
  it("is a 64-char hex digest and matches for equal canonical forms", async () => {
    const a = await hashCheckoutIntent(canonicalCheckoutIntent(stay()));
    const b = await hashCheckoutIntent(canonicalCheckoutIntent(stay({ email: "JAMIE@email.com" })));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
});

describe("decideWebCheckoutReplay", () => {
  it("replays a cached Stripe/Viva URL ahead of everything else", () => {
    expect(
      decideWebCheckoutReplay({
        cached: { kind: "payment", reference: "ABC123", url: "https://checkout.stripe.com/s/1" },
        booking: { status: "confirmed", reference: "ABC123" },
        paymentUrl: "https://other.example/pay",
      }),
    ).toEqual({ kind: "payment", url: "https://checkout.stripe.com/s/1" });
  });

  it("sends a second uncarded submit to the existing confirmation", () => {
    expect(
      decideWebCheckoutReplay({
        cached: { kind: "confirmed", reference: "ABC123" },
        booking: { status: "simulated", reference: "ABC123" },
        paymentUrl: null,
      }),
    ).toEqual({ kind: "confirmed", reference: "ABC123" });
  });

  it("reuses a pending payment URL when KV has not caught up", () => {
    expect(
      decideWebCheckoutReplay({
        cached: null,
        booking: null,
        paymentUrl: "https://www.vivapayments.com/web/checkout?ref=9",
      }),
    ).toEqual({ kind: "payment", url: "https://www.vivapayments.com/web/checkout?ref=9" });
  });

  it("reuses a standing booking when the cache is empty", () => {
    expect(
      decideWebCheckoutReplay({
        cached: null,
        booking: { status: "confirmed", lifecycle: "active", reference: "ABC123" },
        paymentUrl: null,
      }),
    ).toEqual({ kind: "confirmed", reference: "ABC123" });
  });

  it("does not reuse a cancelled or failed booking — the guest can try again", () => {
    expect(
      decideWebCheckoutReplay({
        cached: { kind: "confirmed", reference: "ABC123" },
        booking: { status: "confirmed", lifecycle: "cancelled", reference: "ABC123" },
        paymentUrl: null,
      }),
    ).toBeNull();
    expect(
      decideWebCheckoutReplay({
        cached: null,
        booking: { status: "failed", reference: "ABC123" },
        paymentUrl: null,
      }),
    ).toBeNull();
  });

  it("returns null for a first submit (or an in-flight one with no URL yet)", () => {
    expect(decideWebCheckoutReplay({ cached: null, booking: null, paymentUrl: null })).toBeNull();
  });
});
