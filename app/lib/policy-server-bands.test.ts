import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// resolveBookingCancellation against real rate/setting shapes, with the two
// stores it reads mocked. What it must get right: the snapshot carries the
// whole schedule with money on each band; a closed free window is still a live
// booking while a paying band is open (and non-refundable as before when it
// isn't); a rate with no deadline inherits the property default exactly as the
// flat fields always did; several rates merge to the harshest.

const rates: Record<string, unknown>[] = [];
let settings: Record<string, unknown> = {};

vi.mock("./catalog.server", () => ({ getRates: async () => rates }));
vi.mock("./overrides.server", () => ({ getSettings: async () => settings }));

const TWO = [
  { deadlineValue: 14, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 },
  { deadlineValue: 7, deadlineUnit: "days", penalty: "full_stay" },
];
const policy = (tiers: unknown[], refundable = true) => ({
  payment: { timing: "full_prepay", card: "charge_at_booking" },
  cancellation: { refundable, tiers },
  noShow: { penalty: "full_stay" },
});
const STAY = { total: 600, nights: 3 };
const CHECKIN = "2026-11-20";

beforeEach(() => {
  rates.length = 0;
  settings = { cancelAnchorTime: "18:00", timezone: "Etc/UTC" };
});
afterEach(() => vi.useRealTimers());

describe("resolveBookingCancellation", () => {
  it("snapshots every band with its penalty in money, and the free deadline as before", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-10-01T00:00:00Z"));
    rates.push({ id: "r1", policy: policy(TWO) });
    const { resolveBookingCancellation } = await import("./policy.server");

    const snap = await resolveBookingCancellation("p", ["r1"], CHECKIN, STAY);
    expect(snap.refundable).toBe(true);
    expect(snap.cancelByISO).toBe("2026-11-06T18:00:00.000Z");
    expect(snap.cancelByLocal).toBe("2026-11-06T18:00");
    expect(snap.bands?.map((b) => [b.untilLocal ?? null, b.penalty, b.penaltyAmount])).toEqual([
      ["2026-11-06T18:00", "none", 0],
      ["2026-11-13T18:00", "percent", 300],
      [null, "full_stay", 600],
    ]);
  });

  it("stays a live, partially refundable booking when made inside a paying band", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-10T00:00:00Z"));
    rates.push({ id: "r1", policy: policy(TWO) });
    const { resolveBookingCancellation } = await import("./policy.server");

    const snap = await resolveBookingCancellation("p", ["r1"], CHECKIN, STAY);
    expect(snap.refundable).toBe(true);
    // The free deadline is in the past and stays on record; the bands say what
    // still applies.
    expect(snap.cancelByISO).toBe("2026-11-06T18:00:00.000Z");
    expect(snap.bands).toHaveLength(3);
  });

  it("is non-refundable from the outset when only the last band is left — exactly as before", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-15T00:00:00Z"));
    rates.push({ id: "r1", policy: policy(TWO) });
    const { resolveBookingCancellation } = await import("./policy.server");

    expect(await resolveBookingCancellation("p", ["r1"], CHECKIN, STAY)).toEqual({ refundable: false, cancelByISO: null });
  });

  it("gives a rate with no deadline the property default, as the flat fields did", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-10-01T00:00:00Z"));
    settings = { ...settings, cancelDeadlineValue: 48, cancelDeadlineUnit: "hours" };
    rates.push({ id: "r1", policy: policy([]) });
    const { resolveBookingCancellation } = await import("./policy.server");

    const snap = await resolveBookingCancellation("p", ["r1"], CHECKIN, STAY);
    expect(snap.cancelByLocal).toBe("2026-11-18T18:00");
    expect(snap.bands?.map((b) => b.penalty)).toEqual(["none", "full_stay"]);
  });

  it("reads a legacy rate's flat fields", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-10-01T00:00:00Z"));
    rates.push({ id: "r1", refundable: true, cancelDeadlineValue: 2, cancelDeadlineUnit: "days" });
    const { resolveBookingCancellation } = await import("./policy.server");

    const snap = await resolveBookingCancellation("p", ["r1"], CHECKIN, STAY);
    expect(snap.cancelByLocal).toBe("2026-11-18T18:00");
    expect(snap.bands?.[1]).toMatchObject({ penalty: "full_stay", penaltyAmount: 600 });
  });

  it("merges several rates to the harshest schedule and is refundable only if all are", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-10-01T00:00:00Z"));
    rates.push({ id: "a", policy: policy(TWO) }, { id: "b", policy: policy([{ deadlineValue: 10, deadlineUnit: "days", penalty: "full_stay" }]) });
    const { resolveBookingCancellation } = await import("./policy.server");

    const snap = await resolveBookingCancellation("p", ["a", "b"], CHECKIN, STAY);
    expect(snap.bands?.map((b) => [b.untilLocal ?? null, b.penalty])).toEqual([
      ["2026-11-06T18:00", "none"],
      ["2026-11-10T18:00", "percent"],
      [null, "full_stay"],
    ]);

    rates.push({ id: "c", policy: policy([], false) });
    const mixed = await resolveBookingCancellation("p", ["a", "c"], CHECKIN, STAY);
    expect(mixed.refundable).toBe(false);
  });

  it("has no bands and no deadline for a rate that is free any time", async () => {
    rates.push({ id: "r1", policy: policy([]) });
    const { resolveBookingCancellation } = await import("./policy.server");

    expect(await resolveBookingCancellation("p", ["r1"], CHECKIN, STAY)).toEqual({ refundable: true, cancelByISO: null, cancelByLocal: undefined });
  });
});

describe("resolveBookingPolicy", () => {
  it("merges the cancellation schedules of a mixed cart rather than picking one", async () => {
    rates.push({ id: "a", policy: policy(TWO) }, { id: "b", policy: policy([{ deadlineValue: 10, deadlineUnit: "days", penalty: "full_stay" }]) });
    const { resolveBookingPolicy } = await import("./policy.server");

    const merged = await resolveBookingPolicy("p", ["a", "b"]);
    expect(merged.cancellation.tiers).toEqual([
      { deadlineValue: 14, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 },
      { deadlineValue: 10, deadlineUnit: "days", penalty: "full_stay", penaltyValue: undefined },
    ]);
  });
});
