import { describe, expect, it } from "vitest";

// The one gate the guest's button, its confirmation, the action's re-check and
// the admin's refund field all read. Pinned across the three shapes a booking's
// snapshot can have: from before bands existed (single deadline), a schedule,
// and non-refundable — and across what was actually charged.
import { resolveBands } from "./cancel-bands";
import { cancelGate, policyRefundNow } from "./cancel-gate";
import type { CancelTier } from "./rate-policy";

const TWO: CancelTier[] = [
  { deadlineValue: 14, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 },
  { deadlineValue: 7, deadlineUnit: "days", penalty: "full_stay" },
];
const CHECKIN = "2026-11-20";
const UTC = { time: "18:00", timezone: "Etc/UTC" };
const bands = resolveBands(TWO, CHECKIN, UTC, { total: 600, nights: 3 })!;
const at = (iso: string) => Date.parse(iso);

const paid = (amount: number) => ({ provider: "stripe", mode: "payment", amount, currency: "GBP", accountId: "acct", paymentIntentId: "pi", sessionId: "cs" }) as never;
const card = { provider: "stripe", mode: "setup", sessionId: "cs" } as never;

const scheduled = { cancellation: { refundable: true, cancelByISO: bands[0].untilISO, cancelByLocal: bands[0].untilLocal, bands }, payment: paid(600) };

describe("cancelGate with a schedule", () => {
  it("refunds everything in the free band", () => {
    expect(cancelGate(scheduled, true, at("2026-11-01T00:00:00Z"))).toMatchObject({ canCancel: true, charged: 600, refund: 600 });
  });

  it("refunds the band's share inside a paying band, and names the band", () => {
    const g = cancelGate(scheduled, true, at("2026-11-10T00:00:00Z"));
    expect(g).toMatchObject({ canCancel: true, charged: 600, refund: 300 });
    expect(g.canCancel && g.band?.penalty).toBe("percent");
  });

  it("is inclusive at a boundary, like the bands themselves", () => {
    expect(cancelGate(scheduled, true, at("2026-11-06T18:00:00.000Z"))).toMatchObject({ refund: 600 });
    expect(cancelGate(scheduled, true, at("2026-11-06T18:00:00.001Z"))).toMatchObject({ refund: 300 });
  });

  it("hands the last band to the hotel, as the single deadline always did", () => {
    expect(cancelGate(scheduled, true, at("2026-11-15T00:00:00Z"))).toEqual({ canCancel: false, reason: "deadline" });
  });

  it("refunds nothing on a deposit the penalty exceeds, but still lets the guest cancel", () => {
    const deposit = { ...scheduled, payment: paid(180) };
    expect(cancelGate(deposit, true, at("2026-11-10T00:00:00Z"))).toMatchObject({ canCancel: true, charged: 180, refund: 0 });
  });

  it("has nothing to refund on a guarantee-card booking", () => {
    expect(cancelGate({ ...scheduled, payment: card }, true, at("2026-11-10T00:00:00Z"))).toMatchObject({ canCancel: true, charged: 0, refund: 0 });
  });
});

describe("cancelGate without a schedule (bookings from before bands)", () => {
  const legacy = { cancellation: { refundable: true, cancelByISO: "2026-11-13T18:00:00.000Z" }, payment: paid(600) };

  it("is the single deadline: everything back before it, the hotel after", () => {
    expect(cancelGate(legacy, true, at("2026-11-10T00:00:00Z"))).toMatchObject({ canCancel: true, refund: 600, band: null });
    expect(cancelGate(legacy, true, at("2026-11-15T00:00:00Z"))).toEqual({ canCancel: false, reason: "deadline" });
  });

  it("keeps the other two refusals", () => {
    expect(cancelGate(legacy, false, at("2026-11-10T00:00:00Z"))).toEqual({ canCancel: false, reason: "notAllowed" });
    expect(cancelGate({ ...legacy, cancellation: { refundable: false, cancelByISO: null } }, true)).toEqual({ canCancel: false, reason: "nonRefundable" });
  });

  it("is free any time with no snapshot at all", () => {
    expect(cancelGate({ payment: paid(600) }, true)).toMatchObject({ canCancel: true, refund: 600 });
  });
});

describe("policyRefundNow", () => {
  it("follows the band the admin is looking at, including the ones the guest can't use", () => {
    expect(policyRefundNow(scheduled, at("2026-11-01T00:00:00Z"))).toEqual({ charged: 600, refund: 600 });
    expect(policyRefundNow(scheduled, at("2026-11-10T00:00:00Z"))).toEqual({ charged: 600, refund: 300 });
    expect(policyRefundNow(scheduled, at("2026-11-15T00:00:00Z"))).toEqual({ charged: 600, refund: 0 });
  });

  it("says 0 for a non-refundable rate and the full charge with no snapshot", () => {
    expect(policyRefundNow({ cancellation: { refundable: false, cancelByISO: null }, payment: paid(600) })).toEqual({ charged: 600, refund: 0 });
    expect(policyRefundNow({ payment: paid(600) })).toEqual({ charged: 600, refund: 600 });
  });

  it("is null when there is nothing to refund", () => {
    expect(policyRefundNow({ ...scheduled, payment: card })).toBeNull();
    expect(policyRefundNow({ ...scheduled, payment: { ...paid(600), refund: { id: "re", amount: 600, at: "t" } } as never })).toBeNull();
  });
});
