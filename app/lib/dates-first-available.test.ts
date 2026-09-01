import { describe, expect, it } from "vitest";

import type { ClosedDates } from "./channex/types";
import { firstAvailableStay } from "./dates";

const closed = (partial: Partial<ClosedDates>): ClosedDates => ({
  closed: [],
  closedToArrival: [],
  closedToDeparture: [],
  minStayArrival: {},
  minStayThrough: {},
  ...partial,
});

describe("firstAvailableStay", () => {
  it("returns null with no availability data — no guessing off nothing", () => {
    expect(firstAvailableStay(null, "2026-09-01")).toBeNull();
  });

  it("picks the floor date itself when it is open, for one night", () => {
    expect(firstAvailableStay(closed({}), "2026-09-01")).toEqual({
      checkin: "2026-09-01",
      checkout: "2026-09-02",
    });
  });

  it("skips sold and closed-to-arrival dates to the first real arrival", () => {
    const cd = closed({
      closed: ["2026-09-01", "2026-09-02"],
      closedToArrival: ["2026-09-03"],
    });
    expect(firstAvailableStay(cd, "2026-09-01")).toEqual({
      checkin: "2026-09-04",
      checkout: "2026-09-05",
    });
  });

  it("honours the arrival date's min-stay for the check-out", () => {
    const cd = closed({ minStayArrival: { "2026-09-01": 3 } });
    expect(firstAvailableStay(cd, "2026-09-01")).toEqual({
      checkin: "2026-09-01",
      checkout: "2026-09-04",
    });
  });

  it("skips an arrival whose open run is shorter than its min-stay", () => {
    // Sep 1 needs 3 nights but Sep 2 is sold — a dead-end arrival the calendar
    // also refuses, so the pre-selection must not land on it either.
    const cd = closed({
      closed: ["2026-09-02"],
      minStayArrival: { "2026-09-01": 3 },
    });
    expect(firstAvailableStay(cd, "2026-09-01")).toEqual({
      checkin: "2026-09-03",
      checkout: "2026-09-04",
    });
  });

  it("extends the stay past a closed-to-departure check-out", () => {
    const cd = closed({ closedToDeparture: ["2026-09-02"] });
    expect(firstAvailableStay(cd, "2026-09-01")).toEqual({
      checkin: "2026-09-01",
      checkout: "2026-09-03",
    });
  });

  it("returns null when nothing is bookable in the scan horizon", () => {
    const days: string[] = [];
    const d = new Date(Date.parse("2026-09-01T00:00:00Z"));
    for (let i = 0; i < 800; i++) {
      days.push(new Date(d.getTime() + i * 86_400_000).toISOString().slice(0, 10));
    }
    expect(firstAvailableStay(closed({ closed: days }), "2026-09-01")).toBeNull();
  });
});
