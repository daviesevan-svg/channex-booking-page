// Server side of the calendar window: read the months the page actually needs.
//
// The guest loaders used to read the picker's whole thirteen-month horizon
// before rendering. They now read the first few (calendar-window.ts) and let
// the browser fetch the rest as the guest pages forward.
//
// The one thing that still needs more than the initial slice is the
// preselect-first-available setting, which has to name a real bookable stay. A
// property with something free next week answers from the first slice; one sold
// out for months extends until it finds a stay, which is no worse than the old
// unconditional full read and is the only case that pays for it.
import { getCalendarAvailability } from "./catalog.server";
import { calendarHorizonEnd, extendCalendarWindow, initialCalendarWindow, mergeClosedDates } from "./calendar-window";
import type { ClosedDates } from "./channex/types";

export interface CalendarWindow {
  closedDates: ClosedDates | null;
  /** Last date `closedDates` covers, or null when nothing could be read. Travels
   *  to the client, which must not treat later dates as available. */
  loadedThrough: string | null;
}

/** Nothing loaded — the page renders exactly as it does when the calendar read
 *  fails today: no dates greyed, the results page gates the stay instead. */
const NOTHING: CalendarWindow = { closedDates: null, loadedThrough: null };

export async function loadCalendarWindow(
  pid: string,
  from: string,
  opts: {
    roomId?: string;
    /** Keep extending the window while this says the answer isn't in yet. */
    until?: (closedDates: ClosedDates, loadedThrough: string) => boolean;
  } = {},
): Promise<CalendarWindow> {
  const horizonEnd = calendarHorizonEnd(from);
  try {
    const first = initialCalendarWindow(from);
    let closedDates = await getCalendarAvailability(pid, first.from, first.to, { roomId: opts.roomId });
    let loadedThrough = first.to;

    while (opts.until && !opts.until(closedDates, loadedThrough)) {
      // One more chunk. Null at the horizon, which is where a property with
      // nothing bookable all year stops.
      const next = extendCalendarWindow(loadedThrough, horizonEnd);
      if (!next) break;
      closedDates = mergeClosedDates(closedDates, await getCalendarAvailability(pid, next.from, next.to, { roomId: opts.roomId }));
      loadedThrough = next.to;
    }
    return { closedDates, loadedThrough };
  } catch {
    // Fail open, as the loaders always have: a calendar hiccup must not take
    // the page down with it.
    return NOTHING;
  }
}
