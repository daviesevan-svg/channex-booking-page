import { describe, expect, it } from "vitest";

import {
  SessionBindError,
  assertCollectedPayment,
  assertSessionMatchesPending,
  bookingSessionTarget,
  refsFromStripeCheckoutEvent,
  shouldRefundMismatchedSession,
  voucherSessionTarget,
  type BindableSession,
  type SessionBindTarget,
} from "./stripe-session-bind";

const depositTarget: SessionBindTarget = {
  ref: "EXPENSIVE1",
  pid: "prop_hotel",
  expectedMode: "payment",
  expectedAmount: 500,
  expectedCurrency: "GBP",
};

const matchingDeposit: BindableSession = {
  client_reference_id: "EXPENSIVE1",
  metadata: { reference: "EXPENSIVE1", pid: "prop_hotel" },
  mode: "payment",
  amount_total: 50000,
  currency: "gbp",
};

function expectReason(fn: () => void, reason: SessionBindError["reason"]) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SessionBindError);
    expect((e as SessionBindError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected SessionBindError(${reason})`);
}

describe("assertSessionMatchesPending", () => {
  it("accepts a session bound to the pending with matching money and mode", () => {
    expect(() => assertSessionMatchesPending(matchingDeposit, depositTarget)).not.toThrow();
  });

  it("rejects a completed cheap session_id swapped onto an expensive pending ref", () => {
    const cheapSession: BindableSession = {
      client_reference_id: "CHEAPREF1",
      metadata: { reference: "CHEAPREF1", pid: "prop_hotel" },
      mode: "payment",
      amount_total: 100,
      currency: "gbp",
    };
    expectReason(() => assertSessionMatchesPending(cheapSession, depositTarget), "unbound_session");
  });

  it("rejects a session with no client_reference_id", () => {
    expectReason(
      () => assertSessionMatchesPending({ ...matchingDeposit, client_reference_id: null }, depositTarget),
      "unbound_session",
    );
  });

  it("rejects metadata.reference that disagrees with the pending ref", () => {
    expectReason(
      () =>
        assertSessionMatchesPending(
          { ...matchingDeposit, metadata: { reference: "OTHERREF1", pid: "prop_hotel" } },
          depositTarget,
        ),
      "unbound_session",
    );
  });

  it("rejects a session whose metadata.pid does not match the pending property", () => {
    expectReason(
      () =>
        assertSessionMatchesPending(
          { ...matchingDeposit, metadata: { reference: "EXPENSIVE1", pid: "prop_other" } },
          depositTarget,
        ),
      "property_mismatch",
    );
  });

  it("rejects a guarantee setup session swapped onto a deposit pending", () => {
    const setupSession: BindableSession = {
      client_reference_id: "EXPENSIVE1",
      metadata: { reference: "EXPENSIVE1", pid: "prop_hotel" },
      mode: "setup",
      amount_total: 0,
      currency: "gbp",
    };
    expectReason(() => assertSessionMatchesPending(setupSession, depositTarget), "mode_mismatch");
  });

  it("rejects a payment session swapped onto a guarantee pending", () => {
    const guarantee = bookingSessionTarget({
      pid: "prop_hotel",
      record: { reference: "GUARANTEE1", currency: "GBP", consent: { dueNow: 0 } },
    });
    expect(guarantee.expectedMode).toBe("setup");
    expectReason(
      () =>
        assertSessionMatchesPending(
          {
            client_reference_id: "GUARANTEE1",
            metadata: { reference: "GUARANTEE1", pid: "prop_hotel" },
            mode: "payment",
            amount_total: 100,
            currency: "gbp",
          },
          guarantee,
        ),
      "mode_mismatch",
    );
  });

  it("rejects amount mismatch (cheap charge, expensive pending)", () => {
    expectReason(
      () => assertSessionMatchesPending({ ...matchingDeposit, amount_total: 100 }, depositTarget),
      "amount_mismatch",
    );
  });

  it("rejects currency mismatch even when minor units coincide", () => {
    // ¥500 is 500 minor; £5.00 is also 500 minor. Must not pass.
    expectReason(
      () => assertSessionMatchesPending({ ...matchingDeposit, amount_total: 500, currency: "jpy" }, depositTarget),
      "currency_mismatch",
    );
  });

  it("does not require amount_total on a matching setup session", () => {
    const guarantee = bookingSessionTarget({
      pid: "prop_hotel",
      record: { reference: "GUARANTEE1", currency: "EUR", consent: { dueNow: 0 } },
    });
    expect(() =>
      assertSessionMatchesPending(
        {
          client_reference_id: "GUARANTEE1",
          metadata: { reference: "GUARANTEE1", pid: "prop_hotel" },
          mode: "setup",
          currency: "eur",
        },
        guarantee,
      ),
    ).not.toThrow();
  });
});

describe("bookingSessionTarget / voucherSessionTarget", () => {
  it("treats dueNow > 0 as payment and dueNow 0 as setup", () => {
    expect(
      bookingSessionTarget({
        pid: "p",
        record: { reference: "R1", currency: "USD", consent: { dueNow: 12.5 } },
      }).expectedMode,
    ).toBe("payment");
    expect(
      bookingSessionTarget({
        pid: "p",
        record: { reference: "R2", currency: "USD" },
      }).expectedMode,
    ).toBe("setup");
  });

  it("builds a payment target from the voucher price and property currency", () => {
    expect(
      voucherSessionTarget({ pid: "prop_hotel", record: { product: { price: 80 } } }, "VOUCHREF1", "EUR"),
    ).toEqual({
      ref: "VOUCHREF1",
      pid: "prop_hotel",
      expectedMode: "payment",
      expectedAmount: 80,
      expectedCurrency: "EUR",
    });
  });
});

describe("assertCollectedPayment", () => {
  it("allows a missing payment (test-mode / no-gateway finalize)", () => {
    expect(() =>
      assertCollectedPayment(undefined, { mode: "payment", amount: 500, currency: "GBP" }, "REF"),
    ).not.toThrow();
  });

  it("fails closed when a setup payment is offered for a deposit draft", () => {
    expectReason(
      () =>
        assertCollectedPayment(
          { mode: "setup" },
          { mode: "payment", amount: 500, currency: "GBP" },
          "EXPENSIVE1",
        ),
      "mode_mismatch",
    );
  });

  it("fails closed on amount/currency mismatch instead of logging-and-continuing", () => {
    expectReason(
      () =>
        assertCollectedPayment(
          { mode: "payment", amount: 1, currency: "GBP" },
          { mode: "payment", amount: 500, currency: "GBP" },
          "EXPENSIVE1",
        ),
      "amount_mismatch",
    );
    expectReason(
      () =>
        assertCollectedPayment(
          { mode: "payment", amount: 500, currency: "EUR" },
          { mode: "payment", amount: 500, currency: "GBP" },
          "EXPENSIVE1",
        ),
      "currency_mismatch",
    );
  });
});

describe("shouldRefundMismatchedSession", () => {
  it("refunds only a session bound to this pending whose money is wrong", () => {
    expect(shouldRefundMismatchedSession("amount_mismatch")).toBe(true);
    expect(shouldRefundMismatchedSession("currency_mismatch")).toBe(true);
    expect(shouldRefundMismatchedSession("unbound_session")).toBe(false);
    expect(shouldRefundMismatchedSession("property_mismatch")).toBe(false);
    expect(shouldRefundMismatchedSession("mode_mismatch")).toBe(false);
  });
});

describe("refsFromStripeCheckoutEvent (webhook)", () => {
  it("binds finalize to Stripe's client_reference_id, not a guest query param", () => {
    expect(
      refsFromStripeCheckoutEvent({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_cheap",
            client_reference_id: "EXPENSIVE1",
            metadata: { pid: "prop_hotel" },
          },
        },
      }),
    ).toEqual({ ref: "EXPENSIVE1", sessionId: "cs_cheap", kind: "booking" });
  });

  it("routes voucher sessions by metadata.kind and ignores other event types", () => {
    expect(
      refsFromStripeCheckoutEvent({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_v",
            client_reference_id: "VOUCHREF1",
            metadata: { kind: "voucher", pid: "prop_hotel" },
          },
        },
      }),
    ).toEqual({ ref: "VOUCHREF1", sessionId: "cs_v", kind: "voucher" });
    expect(refsFromStripeCheckoutEvent({ type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } })).toBeNull();
  });

  it("is a no-op (idempotent skip) when the verified event has no reference", () => {
    expect(
      refsFromStripeCheckoutEvent({
        type: "checkout.session.completed",
        data: { object: { id: "cs_1" } },
      }),
    ).toBeNull();
  });
});

describe("webhook retrieve still re-binds the session to the pending", () => {
  // The webhook looks up pending by the event's client_reference_id, then
  // re-fetches the session. That retrieved session must still pass the helper
  // — a swapped session id cannot finalize even if the event ref is honest.
  it("still rejects when the retrieved session is not the pending's session", () => {
    const pending = bookingSessionTarget({
      pid: "prop_hotel",
      record: { reference: "EXPENSIVE1", currency: "GBP", consent: { dueNow: 500 } },
    });
    const retrievedOther: BindableSession = {
      client_reference_id: "CHEAPREF1",
      metadata: { reference: "CHEAPREF1", pid: "prop_hotel" },
      mode: "payment",
      amount_total: 100,
      currency: "gbp",
    };
    expectReason(() => assertSessionMatchesPending(retrievedOther, pending), "unbound_session");
  });

  it("accepts the retrieved session when it is the one the event's ref points at", () => {
    const pending = bookingSessionTarget({
      pid: "prop_hotel",
      record: { reference: "EXPENSIVE1", currency: "GBP", consent: { dueNow: 500 } },
    });
    expect(() => assertSessionMatchesPending(matchingDeposit, pending)).not.toThrow();
  });

  it("applies the same bind to a voucher pending (cheap session_id cannot issue an expensive voucher)", () => {
    const target = voucherSessionTarget(
      { pid: "prop_hotel", record: { product: { price: 200 } } },
      "VOUCHEXP1",
      "GBP",
    );
    expectReason(
      () =>
        assertSessionMatchesPending(
          {
            client_reference_id: "VOUCHCHEAP",
            metadata: { kind: "voucher", reference: "VOUCHCHEAP", pid: "prop_hotel" },
            mode: "payment",
            amount_total: 1000,
            currency: "gbp",
          },
          target,
        ),
      "unbound_session",
    );
    expectReason(
      () =>
        assertSessionMatchesPending(
          {
            client_reference_id: "VOUCHEXP1",
            metadata: { kind: "voucher", reference: "VOUCHEXP1", pid: "prop_hotel" },
            mode: "payment",
            amount_total: 1000,
            currency: "gbp",
          },
          target,
        ),
      "amount_mismatch",
    );
  });
});
