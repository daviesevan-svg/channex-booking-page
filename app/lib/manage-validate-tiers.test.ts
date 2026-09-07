import { describe, expect, it } from "vitest";

// PUT /v1/manage/rates used to accept any array of tiers in any order and then
// ignore all but the first. It now runs the same shape check as the rate
// editor, so a schedule is either right everywhere or refused everywhere.
import { validateRateInput } from "./manage-validate";

const opts = { create: true, roomIds: new Set(["room1"]) };
const rate = (tiers: unknown[]) => ({
  title: "Flexible",
  prices: { room1: 120 },
  policy: {
    payment: { timing: "full_prepay", card: "charge_at_booking" },
    cancellation: { refundable: true, tiers },
    no_show: { penalty: "full_stay" },
  },
});
const errorsOf = (r: ReturnType<typeof validateRateInput>) => (r.ok ? {} : r.errors);

describe("validateRateInput: cancellation tiers", () => {
  it("keeps a well-formed schedule whole", () => {
    const r = validateRateInput(
      rate([
        { deadline_value: 14, deadline_unit: "days", penalty: "percent", penalty_value: 50 },
        { deadline_value: 7, deadline_unit: "days", penalty: "full_stay" },
      ]),
      opts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.policy?.cancellation.tiers).toEqual([
        { deadlineValue: 14, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 },
        { deadlineValue: 7, deadlineUnit: "days", penalty: "full_stay", penaltyValue: undefined },
      ]);
    }
  });

  it("refuses tiers that get further from arrival, or kinder", () => {
    expect(
      errorsOf(
        validateRateInput(
          rate([
            { deadline_value: 7, deadline_unit: "days", penalty: "percent", penalty_value: 50 },
            { deadline_value: 14, deadline_unit: "days", penalty: "full_stay" },
          ]),
          opts,
        ),
      ).policy?.[0],
    ).toMatch(/closer to arrival/);
    expect(
      errorsOf(
        validateRateInput(
          rate([
            { deadline_value: 14, deadline_unit: "days", penalty: "full_stay" },
            { deadline_value: 7, deadline_unit: "days", penalty: "percent", penalty_value: 50 },
          ]),
          opts,
        ),
      ).policy?.[0],
    ).toMatch(/can't charge less/);
  });

  it("wants a value for a percentage, and refuses a do-nothing step in a schedule", () => {
    expect(errorsOf(validateRateInput(rate([{ deadline_value: 7, deadline_unit: "days", penalty: "percent" }]), opts)).policy?.[0]).toMatch(/between 1 and 100/);
    expect(
      errorsOf(
        validateRateInput(
          rate([
            { deadline_value: 14, deadline_unit: "days", penalty: "none" },
            { deadline_value: 7, deadline_unit: "days", penalty: "full_stay" },
          ]),
          opts,
        ),
      ).policy?.[0],
    ).toMatch(/must charge something/);
  });

  it("still takes a plain single tier, and an empty schedule", () => {
    expect(validateRateInput(rate([{ deadline_value: 1, deadline_unit: "days", penalty: "full_stay" }]), opts).ok).toBe(true);
    expect(validateRateInput(rate([]), opts).ok).toBe(true);
  });
});
