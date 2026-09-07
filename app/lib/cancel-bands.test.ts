import { describe, expect, it } from "vitest";

// The schedule behind a multi-step cancellation policy, pinned at the pure
// layer: tiers → bands against a real check-in date, what a cancellation costs
// and refunds, which band "now" is in, how two rates' schedules merge, and what
// the editor and the API must refuse. docs/cancellation-tiers.md §3.
import { bandAt, bandRefund, isPartialBand, mergeTiers, penaltyAmount, resolveBands, validateTiers } from "./cancel-bands";
import { cancellationBandMessages, cancellationMessage, type CancelBand } from "./cancellation";
import { consentGate } from "./checkout-totals";
import type { CancelTier, RatePolicy } from "./rate-policy";

// 100% back at 14+ days, 50% at 7–13, nothing after — the policy that prompted
// this. Check-in 20 Nov: free until 6 Nov 18:00, half until 13 Nov 18:00.
const TWO: CancelTier[] = [
  { deadlineValue: 14, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 },
  { deadlineValue: 7, deadlineUnit: "days", penalty: "full_stay" },
];
const CHECKIN = "2026-11-20";
const UTC = { time: "18:00", timezone: "Etc/UTC" };
const STAY = { total: 600, nights: 3 };
const at = (iso: string) => Date.parse(iso);

describe("resolveBands", () => {
  it("turns N tiers into N+1 bands, the free one first and the last running to arrival", () => {
    const bands = resolveBands(TWO, CHECKIN, UTC, STAY)!;
    expect(bands).toEqual([
      { untilISO: "2026-11-06T18:00:00.000Z", untilLocal: "2026-11-06T18:00", penalty: "none", penaltyAmount: 0 },
      { untilISO: "2026-11-13T18:00:00.000Z", untilLocal: "2026-11-13T18:00", penalty: "percent", penaltyValue: 50, penaltyAmount: 300 },
      { untilISO: null, untilLocal: undefined, penalty: "full_stay", penaltyValue: undefined, penaltyAmount: 600 },
    ]);
  });

  it("carries no amounts when the stay isn't known (the checkout preview)", () => {
    const bands = resolveBands(TWO, CHECKIN, UTC)!;
    expect(bands.map((b) => b.penaltyAmount)).toEqual([undefined, undefined, undefined]);
    expect(bands.map((b) => b.penalty)).toEqual(["none", "percent", "full_stay"]);
  });

  it("anchors to the hotel's wall clock: the same local time, a different instant per timezone", () => {
    const bkk = resolveBands(TWO, CHECKIN, { time: "18:00", timezone: "Asia/Bangkok" })!;
    expect(bkk[0].untilLocal).toBe("2026-11-06T18:00");
    expect(bkk[0].untilISO).toBe("2026-11-06T11:00:00.000Z");
  });

  it("keeps 0 as a real deadline — the anchor time on arrival day", () => {
    const bands = resolveBands([{ deadlineValue: 0, deadlineUnit: "hours", penalty: "full_stay" }], CHECKIN, UTC)!;
    expect(bands[0].untilLocal).toBe("2026-11-20T18:00");
    expect(bands).toHaveLength(2);
  });

  it("is null for an unusable check-in and empty for no tiers", () => {
    expect(resolveBands(TWO, "not-a-date", UTC)).toBeNull();
    expect(resolveBands([], CHECKIN, UTC)).toEqual([]);
  });
});

describe("penaltyAmount", () => {
  it("prices each penalty type against the stay total", () => {
    expect(penaltyAmount("none", undefined, STAY)).toBe(0);
    expect(penaltyAmount("full_stay", undefined, STAY)).toBe(600);
    expect(penaltyAmount("percent", 50, STAY)).toBe(300);
    expect(penaltyAmount("first_night", undefined, STAY)).toBe(200);
    expect(penaltyAmount("fixed", 50, STAY)).toBe(50);
  });

  it("never charges a fixed fee above the stay", () => {
    expect(penaltyAmount("fixed", 1000, STAY)).toBe(600);
  });
});

describe("bandAt", () => {
  const bands = resolveBands(TWO, CHECKIN, UTC, STAY)!;

  it("is inclusive at the boundary — cancelling AT the deadline is inside the band", () => {
    expect(bandAt(bands, at("2026-11-06T18:00:00.000Z"))?.penalty).toBe("none");
    expect(bandAt(bands, at("2026-11-06T18:00:00.001Z"))?.penalty).toBe("percent");
    expect(bandAt(bands, at("2026-11-13T18:00:00.000Z"))?.penalty).toBe("percent");
    expect(bandAt(bands, at("2026-11-13T18:00:00.001Z"))?.penalty).toBe("full_stay");
  });

  it("lands in the last band however late", () => {
    expect(bandAt(bands, at("2027-01-01T00:00:00Z"))?.penalty).toBe("full_stay");
    expect(bandAt([], Date.now())).toBeUndefined();
  });
});

describe("bandRefund", () => {
  const bands = resolveBands(TWO, CHECKIN, UTC, STAY)!;

  it("refunds what was charged less the penalty, clamped to what was charged", () => {
    expect(bandRefund(bands[0], 600)).toBe(600);
    expect(bandRefund(bands[1], 600)).toBe(300);
    expect(bandRefund(bands[2], 600)).toBe(0);
  });

  it("refunds nothing on a deposit smaller than the penalty — the penalty is against the stay", () => {
    expect(bandRefund(bands[1], 180)).toBe(0);
  });

  it("refunds nothing when nothing was charged", () => {
    expect(bandRefund(bands[0], 0)).toBe(0);
  });

  it("is conservative without an amount: all of a free band, none of a charging one", () => {
    const preview = resolveBands(TWO, CHECKIN, UTC)!;
    expect(bandRefund(preview[0], 600)).toBe(600);
    expect(bandRefund(preview[1], 600)).toBe(0);
  });
});

describe("isPartialBand", () => {
  const band = (penalty: CancelBand["penalty"], penaltyValue?: number): CancelBand => ({ untilISO: null, penalty, penaltyValue });
  it("is the middle ground only", () => {
    expect(isPartialBand(band("percent", 50))).toBe(true);
    expect(isPartialBand(band("first_night"))).toBe(true);
    expect(isPartialBand(band("fixed", 40))).toBe(true);
    expect(isPartialBand(band("percent", 100))).toBe(false);
    expect(isPartialBand(band("none"))).toBe(false);
    expect(isPartialBand(band("full_stay"))).toBe(false);
    expect(isPartialBand(undefined)).toBe(false);
  });
});

describe("mergeTiers", () => {
  it("leaves a single schedule alone, and ignores rates with no deadline", () => {
    expect(mergeTiers([TWO])).toEqual(TWO);
    expect(mergeTiers([[], TWO, []])).toEqual(TWO);
    expect(mergeTiers([[], []])).toEqual([]);
  });

  it("takes the harshest penalty at every moment, on the union of the deadlines", () => {
    // A: free →14d, 50% →7d, full. B: free →10d, full.
    // 14–10 days out only A charges (50%); from 10 days B's full stay wins.
    const merged = mergeTiers([TWO, [{ deadlineValue: 10, deadlineUnit: "days", penalty: "full_stay" }]]);
    expect(merged).toEqual([
      { deadlineValue: 14, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 },
      { deadlineValue: 10, deadlineUnit: "days", penalty: "full_stay", penaltyValue: undefined },
    ]);
  });

  it("drops a boundary that changes nothing, and speaks in hours when one that survives isn't a whole day", () => {
    // B's 36-hour step lands inside A's full-stay band: nothing changes there,
    // so the merged schedule is A's, still in days.
    expect(mergeTiers([TWO, [{ deadlineValue: 36, deadlineUnit: "hours", penalty: "full_stay" }]])).toEqual(TWO);
    // Against a 7-day 50% rate the same step DOES bite, and 36 isn't a day.
    const merged = mergeTiers([
      [{ deadlineValue: 7, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 }],
      [{ deadlineValue: 36, deadlineUnit: "hours", penalty: "full_stay" }],
    ]);
    expect(merged.map((t) => [t.deadlineValue, t.deadlineUnit, t.penalty])).toEqual([
      [168, "hours", "percent"],
      [36, "hours", "full_stay"],
    ]);
  });

  it("compares a fixed fee and a percentage by money when the stay is known, by rank otherwise", () => {
    const fixed: CancelTier[] = [{ deadlineValue: 7, deadlineUnit: "days", penalty: "fixed", penaltyValue: 50 }];
    const pct: CancelTier[] = [{ deadlineValue: 7, deadlineUnit: "days", penalty: "percent", penaltyValue: 10 }];
    // 10% of 600 is 60 — more than the £50 fee.
    expect(mergeTiers([fixed, pct], (p, v) => penaltyAmount(p, v, STAY))[0].penalty).toBe("percent");
    // Without amounts a fixed fee is ranked the harsher of the two.
    expect(mergeTiers([fixed, pct])[0].penalty).toBe("fixed");
  });
});

describe("validateTiers", () => {
  const tier = (deadlineValue: number, penalty: CancelTier["penalty"], penaltyValue?: number): CancelTier => ({
    deadlineValue,
    deadlineUnit: "days",
    penalty,
    penaltyValue,
  });

  it("accepts the customer's policy and a plain single tier", () => {
    expect(validateTiers(TWO)).toBeNull();
    expect(validateTiers([tier(1, "full_stay")])).toBeNull();
    expect(validateTiers([tier(1, "none")])).toBeNull();
    expect(validateTiers([])).toBeNull();
  });

  it("refuses tiers out of order or getting kinder", () => {
    expect(validateTiers([tier(7, "percent", 50), tier(14, "full_stay")])).toMatch(/closer to arrival/);
    expect(validateTiers([tier(14, "full_stay"), tier(7, "percent", 50)])).toMatch(/can't charge less/);
    expect(validateTiers([tier(14, "percent", 50), tier(14, "full_stay")])).toMatch(/closer to arrival/);
  });

  it("wants a real value where the penalty type needs one", () => {
    expect(validateTiers([tier(7, "percent")])).toMatch(/between 1 and 100/);
    expect(validateTiers([tier(7, "percent", 101)])).toMatch(/between 1 and 100/);
    expect(validateTiers([tier(7, "fixed")])).toMatch(/amount above 0/);
  });

  it("caps the count and refuses a do-nothing tier inside a schedule", () => {
    expect(validateTiers([tier(30, "first_night"), tier(20, "percent", 25), tier(10, "percent", 50), tier(5, "percent", 75), tier(1, "full_stay")])).toMatch(/At most 4/);
    expect(validateTiers([tier(14, "none"), tier(7, "full_stay")])).toMatch(/must charge something/);
  });
});

describe("cancellationBandMessages", () => {
  const two = { refundable: true, cancelByISO: "2026-11-06T18:00:00.000Z", bands: resolveBands(TWO, CHECKIN, UTC)! };
  const one = {
    refundable: true,
    cancelByISO: "2026-11-13T18:00:00.000Z",
    bands: resolveBands([{ deadlineValue: 7, deadlineUnit: "days", penalty: "full_stay" }], CHECKIN, UTC)!,
  };

  it("lists the bands still ahead, then what follows the last of them", () => {
    expect(cancellationBandMessages(two, at("2026-11-01T00:00:00Z"))).toEqual([
      { key: "cancelBandUntil", iso: "2026-11-13T18:00:00.000Z", local: "2026-11-13T18:00", penalty: "percent", penaltyValue: 50 },
      { key: "afterDeadlineCharge", penalty: "full_stay", penaltyValue: undefined },
    ]);
  });

  it("drops a band once it has passed, and everything once nothing is ahead", () => {
    expect(cancellationBandMessages(two, at("2026-11-10T00:00:00Z")).map((m) => m.key)).toEqual(["cancelBandUntil", "afterDeadlineCharge"]);
    expect(cancellationBandMessages(two, at("2026-11-15T00:00:00Z"))).toEqual([]);
  });

  it("says nothing extra for a single-tier booking unless asked — checkout asks", () => {
    expect(cancellationBandMessages(one, at("2026-11-01T00:00:00Z"))).toEqual([]);
    expect(cancellationBandMessages(one, at("2026-11-01T00:00:00Z"), { alwaysFinal: true })).toEqual([
      { key: "afterDeadlineCharge", penalty: "full_stay", penaltyValue: undefined },
    ]);
    // …but not once the deadline has gone: the lead line already says non-refundable.
    expect(cancellationBandMessages(one, at("2026-11-15T00:00:00Z"), { alwaysFinal: true })).toEqual([]);
  });

  it("has nothing to add for bookings from before bands existed, or non-refundable ones", () => {
    expect(cancellationBandMessages({ refundable: true, cancelByISO: "2026-11-06T18:00:00.000Z" }, at("2026-11-01T00:00:00Z"))).toEqual([]);
    expect(cancellationBandMessages({ ...two, refundable: false }, at("2026-11-01T00:00:00Z"))).toEqual([]);
  });

  it("at checkout inside a paying band, the lead line steps aside for the band lines", () => {
    expect(cancellationMessage(two, at("2026-11-10T00:00:00Z"), { atBooking: true })).toBeNull();
    expect(cancellationMessage(two, at("2026-11-15T00:00:00Z"), { atBooking: true })).toEqual({ key: "nonRefundableBooking" });
    // Looking back at an existing booking, the past deadline is still reported.
    expect(cancellationMessage(two, at("2026-11-10T00:00:00Z"))?.key).toBe("freeCancellationEnded");
  });
});

describe("consentGate with a schedule", () => {
  const policy: RatePolicy = {
    payment: { timing: "full_prepay", card: "charge_at_booking" },
    cancellation: { refundable: true, tiers: TWO },
    noShow: { penalty: "full_stay" },
  };
  const gate = (now: string) => consentGate({ policy, checkin: CHECKIN, anchor: UTC, dueNow: 600, collectsCard: true, now: at(now) });

  it("is an ordinary refundable booking before the free deadline", () => {
    const g = gate("2026-11-01T00:00:00Z");
    expect(g.freeWindowClosed).toBe(false);
    expect(g.nonRefundable).toBe(false);
    expect(g.partialBand).toBeNull();
    expect(g.needAck).toBe(true); // charged today
  });

  it("names the partial band, not 'non-refundable', between the deadlines", () => {
    const g = gate("2026-11-10T00:00:00Z");
    expect(g.freeWindowClosed).toBe(true);
    expect(g.nonRefundable).toBe(false);
    expect(g.partialBand?.penalty).toBe("percent");
    expect(g.needAck).toBe(true);
  });

  it("is non-refundable once only the last band is left", () => {
    const g = gate("2026-11-15T00:00:00Z");
    expect(g.nonRefundable).toBe(true);
    expect(g.partialBand).toBeNull();
  });
});
