import { addDays, addMonths, format, startOfToday } from "date-fns";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CALENDAR_INITIAL_MONTHS,
  extendCalendarWindow,
  calendarHorizonEnd,
  initialCalendarWindow,
  mergeClosedDates,
  monthViewEnd,
  nextCalendarWindow,
} from "./calendar-window";
import type { ClosedDates } from "./channex/types";
import { firstAvailableStay } from "./dates";
import { makeTranslator } from "./i18n";
import { useDateRange, type CalMonth } from "./use-date-range";

const closed = (partial: Partial<ClosedDates> = {}): ClosedDates => ({
  closed: [],
  closedToArrival: [],
  closedToDeparture: [],
  minStayArrival: {},
  minStayThrough: {},
  ...partial,
});

const iso = (d: Date) => format(d, "yyyy-MM-dd");

describe("calendar window arithmetic", () => {
  it("opens on a few months, not the whole horizon", () => {
    const w = initialCalendarWindow("2026-01-15");
    expect(w).toEqual({ from: "2026-01-15", to: "2026-04-15" });
    expect(calendarHorizonEnd("2026-01-15")).toBe("2027-02-15");
    // The saving this whole change exists for.
    expect(CALENDAR_INITIAL_MONTHS).toBeLessThan(13);
  });

  it("extends in chunks, starting the day after what's loaded and stopping at the horizon", () => {
    expect(extendCalendarWindow("2026-04-15", "2027-02-15")).toEqual({ from: "2026-04-16", to: "2026-07-15" });
    // Never past the horizon, and never a gap or an overlap with what's loaded.
    expect(extendCalendarWindow("2027-01-15", "2027-02-15")).toEqual({ from: "2027-01-16", to: "2027-02-15" });
    expect(extendCalendarWindow("2027-02-15", "2027-02-15")).toBeNull();
  });

  it("asks for one window covering a far-off need rather than a chunk at a time", () => {
    // The offer page opens months out: one request, not four round trips.
    expect(nextCalendarWindow("2026-04-15", "2026-11-30", "2027-02-15")).toEqual({ from: "2026-04-16", to: "2027-01-15" });
    expect(nextCalendarWindow("2026-04-15", "2026-03-01", "2027-02-15")).toBeNull();
  });

  it("merges slices without losing either", () => {
    const a = closed({ closed: ["2026-01-01"], minStayArrival: { "2026-01-02": 2 } });
    const b = closed({ closed: ["2026-05-01"], minStayArrival: { "2026-05-02": 3 } });
    const m = mergeClosedDates(a, b);
    expect(m.closed).toEqual(["2026-01-01", "2026-05-01"]);
    expect(m.minStayArrival).toEqual({ "2026-01-02": 2, "2026-05-02": 3 });
    // A new object, or the picker's memoised lookup sets never rebuild.
    expect(m).not.toBe(a);
  });
});

describe("firstAvailableStay inside a partly loaded calendar", () => {
  // The preselect setting fills the date fields in for the guest. Pointing it
  // at a date nobody has checked is worse than not preselecting at all.
  it("refuses to name a stay past the loaded data", () => {
    const cd = closed({ closed: ["2026-09-01", "2026-09-02", "2026-09-03"] });
    // Fully loaded, it walks past the sold run to the next open date.
    expect(firstAvailableStay(cd, "2026-09-01")).toEqual({ checkin: "2026-09-04", checkout: "2026-09-05" });
    // Loaded only through the sold run, the honest answer is "don't know".
    expect(firstAvailableStay(cd, "2026-09-01", "2026-09-03")).toBeNull();
  });

  it("refuses a check-out it has no data for", () => {
    // The arrival is loaded and open, but its 3-night minimum departs past the
    // window — so the stay can't be confirmed.
    const cd = closed({ minStayArrival: { "2026-09-01": 3 } });
    expect(firstAvailableStay(cd, "2026-09-01", "2026-09-02")).toBeNull();
    expect(firstAvailableStay(cd, "2026-09-01", "2026-09-04")).toEqual({ checkin: "2026-09-01", checkout: "2026-09-04" });
  });

  it("still answers from the loaded slice when the stay is inside it", () => {
    expect(firstAvailableStay(closed(), "2026-09-01", "2026-12-01")).toEqual({
      checkin: "2026-09-01",
      checkout: "2026-09-02",
    });
  });
});

/** Render the picker's cells for a given loaded window. Effects don't run under
 *  renderToString, which is fine — this is about what the guest is offered. */
function cellsFor(args: { closedDates: ClosedDates | null; loadedThrough?: string }): Map<string, { disabled: boolean; sold: boolean; past: boolean }> {
  const out = new Map<string, { disabled: boolean; sold: boolean; past: boolean }>();
  function Probe() {
    const { months } = useDateRange({ ...args, tr: makeTranslator("en") });
    for (const m of months as CalMonth[]) {
      for (const c of m.cells) {
        if (c.iso) out.set(c.iso, { disabled: c.disabled, sold: c.sold, past: c.past });
      }
    }
    return null;
  }
  renderToString(createElement(Probe));
  return out;
}

describe("the picker inside a partly loaded calendar", () => {
  // Everything the picker knows about a date being for sale is its ABSENCE from
  // `closed`. So an unloaded month reads as wide open unless the hook is told
  // where the data stops — this is the bug the whole feature turns on.
  const today = startOfToday();
  const tomorrow = iso(addDays(today, 1));
  const nextMonth = iso(addMonths(today, 1));

  it("offers a date inside the loaded window", () => {
    const cells = cellsFor({ closedDates: closed(), loadedThrough: iso(addMonths(today, 3)) });
    expect(cells.get(tomorrow)).toEqual({ disabled: false, sold: false, past: false });
  });

  it("does not offer a date past it — greyed as unknown, not struck through as sold", () => {
    // Loaded only through today: the second visible month is unanswerable.
    const cells = cellsFor({ closedDates: closed(), loadedThrough: iso(today) });
    const cell = cells.get(nextMonth)!;
    expect(cell.disabled).toBe(true);
    // `past` greys it out; `sold` would strike it through and claim someone has
    // it, which nobody has said.
    expect(cell.past).toBe(true);
    expect(cell.sold).toBe(false);
  });

  it("leaves callers with no availability data exactly as they were", () => {
    // The widget and collection pickers pass no data and no window: every date
    // stays selectable, and the results page does the gating.
    const cells = cellsFor({ closedDates: null });
    expect(cells.get(nextMonth)).toEqual({ disabled: false, sold: false, past: false });
  });
});
