import { describe, expect, it } from "vitest";

import { describePolicy, ratePolicyOf, type RatePolicy } from "./rate-policy";

// A hotel's override note is a complete policy statement, usually pasted from
// their channel manager. It used to replace only the cancellation line, so our
// generated payment and no-show sentences stayed around it — a note ending
// "non-show will be charged the total price" rendered directly above our own
// "No-show: the first night charged". These pin that the note now stands alone.

const base: RatePolicy = {
  payment: { timing: "pay_at_hotel", card: "guarantee" },
  cancellation: { refundable: true, tiers: [{ deadlineValue: 21, deadlineUnit: "days", penalty: "full_stay" }] },
  noShow: { penalty: "first_night" },
};

const NOTE =
  "Booking can be cancelled with a penalty at 100% of cost up to 21 days before arrival. Non-show will be charged the total price.";

describe("describePolicy with an override note", () => {
  it("shows the hotel's note alone — no generated payment or no-show line", () => {
    const d = describePolicy({ ...base, overrideNote: NOTE });
    expect(d).toEqual({ payment: "", cancellation: NOTE, noShow: "" });
  });

  it("suppresses them whatever the underlying rules say", () => {
    const d = describePolicy({
      ...base,
      payment: { timing: "full_prepay", card: "charge_at_booking" },
      noShow: { penalty: "full_stay" },
      overrideNote: NOTE,
    });
    expect(d.payment).toBe("");
    expect(d.noShow).toBe("");
    expect(d.cancellation).toBe(NOTE);
  });

  it("applies to a legacy rate whose note came from the flat cancellationNote field", () => {
    const d = describePolicy(ratePolicyOf({ refundable: true, cancelDeadlineValue: 2, cancelDeadlineUnit: "days", cancellationNote: NOTE }));
    expect(d).toEqual({ payment: "", cancellation: NOTE, noShow: "" });
  });

  it("the booking's consent snapshot then records exactly the one line the guest saw", () => {
    // Both checkout and POST /v1/bookings build it this way.
    const d = describePolicy({ ...base, overrideNote: NOTE });
    expect([d.payment, d.cancellation, d.noShow].filter(Boolean)).toEqual([NOTE]);
  });
});

describe("describePolicy without an override note", () => {
  it("still builds all three generated lines", () => {
    const d = describePolicy(base, "18:00");
    expect(d.payment).toBe("Pay at the hotel — nothing due today. Card only guarantees the booking.");
    expect(d.cancellation).toBe("Free cancellation until 18:00, 21 days before arrival, then the full stay is charged.");
    expect(d.noShow).toBe("No-show: the first night charged.");
  });

  it("keeps the payment sentence for prepaid and deposit rates", () => {
    expect(describePolicy({ ...base, payment: { timing: "full_prepay", card: "charge_at_booking" } }).payment).toBe(
      "Full payment due now. Card charged at booking.",
    );
    expect(
      describePolicy({ ...base, payment: { timing: "deposit", card: "charge_at_booking", deposit: { type: "percent", value: 30 } } }).payment,
    ).toBe("Deposit (30%) due now, balance at the hotel. Card charged at booking.");
  });

  it("drops only the no-show line when the rate doesn't charge for one", () => {
    const d = describePolicy({ ...base, noShow: { penalty: "none" } });
    expect(d.noShow).toBe("");
    expect(d.payment).not.toBe("");
    expect(d.cancellation).not.toBe("");
  });

  it("says non-refundable when there is no free window", () => {
    expect(describePolicy({ ...base, cancellation: { refundable: false, tiers: [] } }).cancellation).toBe("Non-refundable.");
  });
});

describe("describePolicy with several tiers", () => {
  const two: RatePolicy = {
    ...base,
    cancellation: {
      refundable: true,
      tiers: [
        { deadlineValue: 14, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 },
        { deadlineValue: 7, deadlineUnit: "days", penalty: "full_stay" },
      ],
    },
  };

  it("walks the schedule: free until, each band until the next deadline, then the last", () => {
    expect(describePolicy(two, "18:00").cancellation).toBe(
      "Free cancellation until 18:00, 14 days before arrival. Until 18:00, 7 days before arrival, 50% of the stay is charged; after that, the full stay is charged.",
    );
  });

  it("keeps going for three", () => {
    const three: RatePolicy = {
      ...two,
      cancellation: {
        refundable: true,
        tiers: [
          { deadlineValue: 30, deadlineUnit: "days", penalty: "first_night" },
          { deadlineValue: 14, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 },
          { deadlineValue: 2, deadlineUnit: "days", penalty: "full_stay" },
        ],
      },
    };
    expect(describePolicy(three, "18:00").cancellation).toBe(
      "Free cancellation until 18:00, 30 days before arrival. Until 18:00, 14 days before arrival, the first night is charged; until 18:00, 2 days before arrival, 50% of the stay is charged; after that, the full stay is charged.",
    );
  });

  it("leaves the single-tier sentence exactly as it was", () => {
    expect(describePolicy(base, "18:00").cancellation).toBe("Free cancellation until 18:00, 21 days before arrival, then the full stay is charged.");
  });
});
