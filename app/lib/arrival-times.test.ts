import { describe, expect, it } from "vitest";

import { arrivalTimes } from "./arrival-times";

describe("arrivalTimes", () => {
  it("offers the whole day when no latest check-in is set — the old behaviour", () => {
    const all = arrivalTimes();
    expect(all).toHaveLength(48);
    expect(all[0]).toBe("00:00");
    expect(all[47]).toBe("23:30");
    expect(arrivalTimes({ from: "15:00" })).toEqual(all);
    expect(arrivalTimes({ from: "15:00", until: null })).toEqual(all);
  });

  it("clips to the check-in window, inclusive at both ends", () => {
    // Camptel: reception 3–6 PM, exactly the seven times they asked for.
    expect(arrivalTimes({ from: "15:00", until: "18:00" })).toEqual([
      "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00",
    ]);
  });

  it("defaults the start to 15:00 when only the latest time is set", () => {
    expect(arrivalTimes({ until: "16:00" })).toEqual(["15:00", "15:30", "16:00"]);
  });

  it("rounds odd minutes inward so nothing outside the window is offered", () => {
    expect(arrivalTimes({ from: "14:10", until: "16:50" })).toEqual(["14:30", "15:00", "15:30", "16:00", "16:30"]);
  });

  it("falls back to the whole day for an empty or inverted window", () => {
    expect(arrivalTimes({ from: "18:00", until: "15:00" })).toHaveLength(48);
    expect(arrivalTimes({ from: "15:00", until: "not a time" })).toHaveLength(48);
  });

  it("never runs past the last slot of the day", () => {
    expect(arrivalTimes({ from: "22:00", until: "23:59" })).toEqual(["22:00", "22:30", "23:00", "23:30"]);
  });
});
