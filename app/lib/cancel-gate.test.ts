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

const scheduled = { checkin: CHECKIN, cancellation: { refundable: true, cancelByISO: bands[0].untilISO, cancelByLocal: bands[0].untilLocal, bands }, payment: paid(600) };

describe("cancelGate with a schedule", () => {
  it("refunds everything in the free band", () => {
    expect(cancelGate(scheduled, true, UTC, at("2026-11-01T00:00:00Z"))).toMatchObject({ canCancel: true, charged: 600, refund: 600 });
  });

  it("refunds the band's share inside a paying band, and names the band", () => {
    const g = cancelGate(scheduled, true, UTC, at("2026-11-10T00:00:00Z"));
    expect(g).toMatchObject({ canCancel: true, charged: 600, refund: 300 });
    expect(g.canCancel && g.band?.penalty).toBe("percent");
  });

  it("is inclusive at a boundary, like the bands themselves", () => {
    expect(cancelGate(scheduled, true, UTC, at("2026-11-06T18:00:00.000Z"))).toMatchObject({ refund: 600 });
    expect(cancelGate(scheduled, true, UTC, at("2026-11-06T18:00:00.001Z"))).toMatchObject({ refund: 300 });
  });

  it("hands the last band to the hotel, as the single deadline always did", () => {
    expect(cancelGate(scheduled, true, UTC, at("2026-11-15T00:00:00Z"))).toEqual({ canCancel: false, reason: "deadline" });
  });

  it("refunds nothing on a deposit the penalty exceeds, but still lets the guest cancel", () => {
    const deposit = { ...scheduled, payment: paid(180) };
    expect(cancelGate(deposit, true, UTC, at("2026-11-10T00:00:00Z"))).toMatchObject({ canCancel: true, charged: 180, refund: 0 });
  });

  it("has nothing to refund on a guarantee-card booking", () => {
    expect(cancelGate({ ...scheduled, payment: card }, true, UTC, at("2026-11-10T00:00:00Z"))).toMatchObject({ canCancel: true, charged: 0, refund: 0 });
  });
});

describe("cancelGate without a schedule (bookings from before bands)", () => {
  const legacy = { checkin: CHECKIN, cancellation: { refundable: true, cancelByISO: "2026-11-13T18:00:00.000Z" }, payment: paid(600) };

  it("is the single deadline: everything back before it, the hotel after", () => {
    expect(cancelGate(legacy, true, UTC, at("2026-11-10T00:00:00Z"))).toMatchObject({ canCancel: true, refund: 600, band: null });
    expect(cancelGate(legacy, true, UTC, at("2026-11-15T00:00:00Z"))).toEqual({ canCancel: false, reason: "deadline" });
  });

  it("keeps the other two refusals", () => {
    expect(cancelGate(legacy, false, UTC, at("2026-11-10T00:00:00Z"))).toEqual({ canCancel: false, reason: "notAllowed" });
    expect(cancelGate({ ...legacy, cancellation: { refundable: false, cancelByISO: null } }, true, UTC, at("2026-11-10T00:00:00Z"))).toEqual({ canCancel: false, reason: "nonRefundable" });
  });

  it("is free any time with no snapshot at all", () => {
    expect(cancelGate({ checkin: CHECKIN, payment: paid(600) }, true, UTC, at("2026-11-10T00:00:00Z"))).toMatchObject({ canCancel: true, refund: 600 });
  });
});

// Arrival is the hotel's cut-off time on the check-in date — 18:00 here. No
// snapshot shape may let a guest cancel (and be auto-refunded) past it: these
// are the three that used to, each tried on arrival day, mid-stay and long
// after check-out.
describe("cancelGate after arrival", () => {
  const AFTER = ["2026-11-20T18:00:00.001Z", "2026-11-21T09:00:00Z", "2026-12-05T00:00:00Z"].map(at);
  const closed = { canCancel: false, reason: "deadline" };

  // "Free until 7 days out, then 50%": the paying band has no end of its own.
  const partialLast = resolveBands([{ deadlineValue: 7, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 }], CHECKIN, UTC, { total: 600, nights: 3 })!;
  const shapes = {
    "no snapshot at all": { checkin: CHECKIN, payment: paid(600) },
    "refundable with no deadline": { checkin: CHECKIN, cancellation: { refundable: true, cancelByISO: null }, payment: paid(600) },
    "a schedule ending in a partial band": { checkin: CHECKIN, cancellation: { refundable: true, cancelByISO: partialLast[0].untilISO, bands: partialLast }, payment: paid(600) },
  };

  for (const [name, booking] of Object.entries(shapes)) {
    it(`${name}: open up to arrival, the hotel's call after`, () => {
      expect(cancelGate(booking, true, UTC, at("2026-11-20T18:00:00.000Z"))).toMatchObject({ canCancel: true });
      for (const now of AFTER) expect(cancelGate(booking, true, UTC, now)).toEqual(closed);
    });
  }

  it("counts arrival on the hotel's clock, not UTC", () => {
    const booking = shapes["refundable with no deadline"];
    const tokyo = { time: "18:00", timezone: "Asia/Tokyo" }; // 18:00 JST = 09:00 UTC
    expect(cancelGate(booking, true, tokyo, at("2026-11-20T09:00:00.000Z"))).toMatchObject({ canCancel: true });
    expect(cancelGate(booking, true, tokyo, at("2026-11-20T09:00:00.001Z"))).toEqual(closed);
    // The default cut-off (18:00) when the hotel never set one.
    expect(cancelGate(booking, true, { timezone: "Etc/UTC" }, at("2026-11-20T18:00:00.001Z"))).toEqual(closed);
  });

  it("refuses a booking whose arrival date is unusable rather than waving it through", () => {
    expect(cancelGate({ ...shapes["no snapshot at all"], checkin: "" }, true, UTC, at("2026-11-01T00:00:00Z"))).toEqual(closed);
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
