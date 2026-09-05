import { describe, expect, it } from "vitest";

import { bookingSideEffects } from "./booking-side-effects";

describe("bookingSideEffects", () => {
  it("does everything for a confirmed booking", () => {
    expect(bookingSideEffects({ status: "confirmed" })).toEqual({
      holdsInventory: true,
      sendsEmails: true,
      dispatchesWebhook: true,
      logsAnalytics: true,
      settlesVoucher: true,
    });
  });

  it("does nothing for a failed one", () => {
    const e = bookingSideEffects({ status: "failed" });
    expect(Object.values(e).every((v) => v === false)).toBe(true);
  });

  it("still does everything for a REAL guest whose push is off", () => {
    // The regression this guards: a property with live bookings off, or no
    // channel manager connected, records `simulated` — but the guest booked
    // and may have paid. Suppressing their email or their inventory hold
    // because the status says "simulated" would be the wrong fix entirely.
    expect(bookingSideEffects({ status: "simulated" })).toEqual({
      holdsInventory: true,
      sendsEmails: true,
      dispatchesWebhook: true,
      logsAnalytics: true,
      settlesVoucher: true,
    });
  });

  it("touches nothing real for an API test key", () => {
    const e = bookingSideEffects({ status: "simulated", testMode: true });
    expect(e.holdsInventory).toBe(false);
    expect(e.sendsEmails).toBe(false);
    expect(e.logsAnalytics).toBe(false);
    // Settling spends gift-voucher balance; a test booking must release it.
    expect(e.settlesVoucher).toBe(false);
  });

  it("still fires the webhook for a test booking, but not a failed one", () => {
    // The integrator owns the property, is testing against it, and the payload
    // states the status — an integration you cannot exercise without touching
    // production is not a usable test mode.
    expect(bookingSideEffects({ status: "simulated", testMode: true }).dispatchesWebhook).toBe(true);
    expect(bookingSideEffects({ status: "failed", testMode: true }).dispatchesWebhook).toBe(false);
  });

  it("treats a missing testMode as real, never the other way round", () => {
    // Defaulting the wrong way would silently stop mailing real guests.
    expect(bookingSideEffects({ status: "confirmed", testMode: undefined }).sendsEmails).toBe(true);
  });
});
