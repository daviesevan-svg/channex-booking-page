import { describe, expect, it } from "vitest";

import type { BookingRecord } from "./bookings.server";
import { attributionFromCookies, parseAttribution, serializeAttribution } from "./attribution";
import { beginCheckoutEvent, cartDelta, clickAttribution, purchaseEvent, viewItemEvent, viewItemListEvent } from "./tracking";

// These numbers become a hotel's revenue in GA4 and their ROAS in Google Ads.
// Everything here is about them being the numbers that were actually charged —
// a wrong one is invisible, permanent, and only ever flattering.

const booking = (over: Partial<BookingRecord> = {}): BookingRecord =>
  ({
    id: "b1",
    reference: "RP-1234",
    status: "confirmed",
    createdAt: "2026-09-01T10:00:00.000Z",
    currency: "EUR",
    checkin: "2026-09-15",
    checkout: "2026-09-17",
    nights: 2,
    total: 480,
    guest: { firstName: "A", lastName: "B", email: "a@b.c", phone: "" },
    rooms: [
      { roomId: "r1", roomTitle: "Garden Suite", rateId: "x", rateTitle: "B&B", adults: 2, children: 1, total: 400 },
    ],
    pricing: { charges: [], taxLines: [{ label: "VAT", amount: 30 }], taxIncluded: 0 },
    extras: [{ id: "e1", name: "Breakfast", unit: "per_stay", unitPrice: 50, qty: 1, amount: 50 }],
    consent: { acceptedAt: "", policyText: [], dueNow: 120, marketingOptIn: false },
    ...over,
  }) as BookingRecord;

const ads = { adsConversionId: "AW-123456789", adsConversionLabel: "AbC-D_efGh" };

describe("the purchase payload", () => {
  it("reports the grand total, and the components that add up to it", () => {
    const e = purchaseEvent(booking(), { propertyId: "p1" })!;
    const ecommerce = e.params.ecommerce as Record<string, unknown>;
    expect(ecommerce.value).toBe(480);
    expect(ecommerce.currency).toBe("EUR");
    expect(ecommerce.transaction_id).toBe("RP-1234");
    expect(ecommerce.tax).toBe(30);
    expect(e.params.room_subtotal).toBe(400);
    expect(e.params.extras_total).toBe(50);
  });

  it("splits what was taken today from what is owed at the hotel", () => {
    const e = purchaseEvent(booking(), { propertyId: "p1" })!;
    expect(e.params.due_now).toBe(120);
    expect(e.params.balance_due).toBe(360);
  });

  it("prices an item at its stay total with quantity 1, so items sum to the transaction", () => {
    const e = purchaseEvent(
      booking({
        total: 900,
        rooms: [
          { roomId: "r1", roomTitle: "A", rateId: "x", rateTitle: "B&B", adults: 2, children: 0, total: 400 },
          { roomId: "r2", roomTitle: "B", rateId: "x", rateTitle: "B&B", adults: 1, children: 0, total: 500 },
        ],
      }),
      { propertyId: "p1" },
    )!;
    const items = (e.params.ecommerce as { items: { price: number; quantity: number }[] }).items;
    expect(items.map((i) => i.price)).toEqual([400, 500]);
    expect(items.every((i) => i.quantity === 1)).toBe(true);
    expect(items.reduce((n, i) => n + i.price * i.quantity, 0)).toBe(900);
  });

  it("carries the stay as parameters GA4 has no dimensions for", () => {
    const e = purchaseEvent(booking(), { propertyId: "prop-9" })!;
    expect(e.params.nights).toBe(2);
    expect(e.params.rooms).toBe(1);
    expect(e.params.adults).toBe(2);
    expect(e.params.children).toBe(1);
    expect(e.params.lead_days).toBe(14);
    expect(e.params.property_id).toBe("prop-9");
  });

  it("distinguishes a captured payment from a card held as a guarantee", () => {
    const captured = purchaseEvent(
      booking({ payment: { provider: "stripe", mode: "payment", accountId: "a", sessionId: "s", amount: 120 } }),
      { propertyId: "p1" },
    )!;
    expect(captured.params.payment_type).toBe("stripe");
    const guarantee = purchaseEvent(
      booking({ payment: { provider: "stripe", mode: "setup", accountId: "a", sessionId: "s" } }),
      { propertyId: "p1" },
    )!;
    expect(guarantee.params.payment_type).toBe("guarantee");
    expect(purchaseEvent(booking({ payment: undefined }), { propertyId: "p1" })!.params.payment_type).toBe("none");
  });

  it("reports nothing for a failed booking — the guest was refunded, it is not revenue", () => {
    expect(purchaseEvent(booking({ status: "failed" }), { propertyId: "p1" })).toBeNull();
  });

  it("reports nothing for a cancelled booking reloaded later, which would inflate ROAS forever", () => {
    expect(purchaseEvent(booking({ lifecycle: "cancelled" }), { propertyId: "p1" })).toBeNull();
  });
});

describe("the Google Ads conversion", () => {
  it("is built from the configured pair, leaving the consent gate to the browser", () => {
    expect(purchaseEvent(booking(), { propertyId: "p1" })!.adsConversion).toBeUndefined();
    const granted = purchaseEvent(booking(), { propertyId: "p1", analytics: ads })!;
    expect(granted.adsConversion).toEqual({
      sendTo: "AW-123456789/AbC-D_efGh",
      value: 480,
      currency: "EUR",
      transactionId: "RP-1234",
    });
  });

  it("is absent when the hotel configured only half of one", () => {
    const half = purchaseEvent(booking(), { propertyId: "p1", analytics: { adsConversionId: "AW-123456789" } })!;
    expect(half.adsConversion).toBeUndefined();
  });
});

describe("click attribution", () => {
  it("takes the parameters that identify the ad, and nothing else", () => {
    const a = clickAttribution("?gclid=abc123&utm_source=google&checkin=2026-09-15&email=someone@example.com");
    expect(a).toEqual({ gclid: "abc123", utm_source: "google" });
  });

  it("bounds a hostile value — this ends up on a record and in a cookie", () => {
    const a = clickAttribution(`?gclid=${"x".repeat(5000)}`);
    expect(a.gclid).toHaveLength(200);
  });

  it("round-trips through the cookie, and re-filters what comes back off the device", () => {
    const raw = serializeAttribution({ gclid: "abc123", utm_campaign: "spring" });
    expect(attributionFromCookies(`rp_consent=x; rp_src=${encodeURIComponent(raw)}`)).toEqual({
      gclid: "abc123",
      utm_campaign: "spring",
    });
    // Edited on the device to smuggle a field we never store.
    expect(parseAttribution('{"gclid":"a","evil":"<script>"}')).toEqual({ gclid: "a" });
    expect(parseAttribution("not json")).toEqual({});
    expect(parseAttribution(undefined)).toEqual({});
  });
});

const stay = { currency: "EUR", checkin: "2026-09-15", checkout: "2026-09-17", nights: 2, adults: 2, children: 0 };
const items = (e: { params: Record<string, unknown> } | null) =>
  (e!.params.ecommerce as { items: { item_id: string; item_variant?: string; price: number }[] }).items;

describe("the funnel events", () => {
  const rooms = [
    { id: "r1", title: "Garden Suite", ratePlans: [
      { title: "Room only", totalPrice: "300", allInTotal: 330 },
      { title: "B&B", totalPrice: "400", allInTotal: 440 },
    ] },
    { id: "r2", title: "Attic", ratePlans: [{ title: "B&B", totalPrice: "200", allInTotal: 220 }] },
  ];

  it("lists each room once, at the all-in price shown on its card", () => {
    const e = viewItemListEvent(rooms, stay)!;
    expect(e.event).toBe("view_item_list");
    expect(items(e)).toEqual([
      { item_id: "r1", item_name: "Garden Suite", item_variant: "Room only", price: 330, quantity: 1 },
      { item_id: "r2", item_name: "Attic", item_variant: "B&B", price: 220, quantity: 1 },
    ]);
  });

  it("sends nothing when a search found nothing — an empty list is not a product view", () => {
    expect(viewItemListEvent([], stay)).toBeNull();
    expect(viewItemListEvent([{ id: "r1", title: "X", ratePlans: [] }], stay)).toBeNull();
  });

  it("reports every rate on a room page, since which one they looked at is the question", () => {
    const e = viewItemEvent(rooms[0], stay)!;
    expect(items(e).map((i) => [i.item_variant, i.price])).toEqual([["Room only", 330], ["B&B", 440]]);
  });

  it("values begin_checkout at the same grand total purchase will report", () => {
    const e = beginCheckoutEvent(
      [{ roomId: "r1", roomTitle: "Garden Suite", rateTitle: "B&B", total: 440 }],
      stay,
      512.5,
    )!;
    expect((e.params.ecommerce as { value: number }).value).toBe(512.5);
    expect(e.params.nights).toBe(2);
  });
});

describe("the cart diff", () => {
  const line = (t: string) => ({ roomId: t.split(":")[0], roomTitle: t.split(":")[0].toUpperCase(), rateTitle: "B&B", total: 100 });

  it("reports an add", () => {
    const [e] = cartDelta("r1:x:2", "r1:x:2,r2:x:2", line, stay);
    expect(e.event).toBe("add_to_cart");
    expect(items(e).map((i) => i.item_id)).toEqual(["r2"]);
  });

  it("reports a removal", () => {
    const [e] = cartDelta("r1:x:2,r2:x:2", "r1:x:2", line, stay);
    expect(e.event).toBe("remove_from_cart");
    expect(items(e).map((i) => i.item_id)).toEqual(["r2"]);
  });

  it("reports both when a room is swapped", () => {
    const out = cartDelta("r1:x:2", "r2:x:2", line, stay);
    expect(out.map((e) => e.event)).toEqual(["add_to_cart", "remove_from_cart"]);
  });

  it("counts the same room twice as two, which a Set would swallow", () => {
    const [e] = cartDelta("r1:x:2", "r1:x:2,r1:x:2", line, stay);
    expect(items(e)).toHaveLength(1);
    const [rm] = cartDelta("r1:x:2,r1:x:2", "r1:x:2", line, stay);
    expect(items(rm)).toHaveLength(1);
  });

  it("reports nothing for a shared link arriving with rooms already in it", () => {
    expect(cartDelta(null, "r1:x:2,r2:x:2,r3:x:2", line, stay)).toEqual([]);
  });

  it("reports nothing when the cart did not change", () => {
    expect(cartDelta("r1:x:2", "r1:x:2", line, stay)).toEqual([]);
  });

  it("drops a token it cannot resolve rather than sending a nameless item", () => {
    expect(cartDelta("", "gone:x:2", () => undefined, stay)).toEqual([]);
  });
});
