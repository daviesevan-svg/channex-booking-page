// Owns the guest page's slice of calendar availability: what has been loaded so
// far, and fetching the next slice when the picker pages past it.
//
// The loaders read the first few months (see calendar-window.ts) instead of the
// whole thirteen-month horizon. This hook holds that initial slice, hands
// useDateRange the date it runs out at, and extends it on demand.
import { useCallback, useRef, useState } from "react";

import { mergeClosedDates, nextCalendarWindow } from "./calendar-window";
import type { ClosedDates } from "./channex/types";

interface Args {
  /** The property's URL base, which the calendar route hangs off. */
  base: string;
  /** The slice the loader already read, and the last date it covers. Both null
   *  when availability couldn't be loaded at all — the page then behaves as it
   *  always did with no data: nothing greyed, the results page gates instead. */
  initial: ClosedDates | null;
  initialThrough: string | null;
  /** Limit to one room, matching the loader's own calendar query. */
  roomId?: string;
  /** Last date worth asking for; the picker can't page past it. */
  horizonEnd: string;
}

export function useCalendarWindow({ base, initial, initialThrough, roomId, horizonEnd }: Args) {
  const [closedDates, setClosedDates] = useState<ClosedDates | null>(initial);
  const [loadedThrough, setLoadedThrough] = useState<string | null>(initialThrough);
  // The furthest date already asked for. Without it, the render that follows a
  // fetch starting re-runs the effect and asks for the same slice again.
  const requested = useRef(initialThrough);

  const extendTo = useCallback(
    (need: string) => {
      const from = requested.current;
      if (!from) return; // no availability data at all — nothing to extend
      const win = nextCalendarWindow(from, need, horizonEnd);
      if (!win) return;
      requested.current = win.to;

      const params = new URLSearchParams({ from: win.from, to: win.to });
      if (roomId) params.set("roomId", roomId);
      fetch(`${base}/calendar?${params}`, { headers: { accept: "application/json" } })
        .then((r) => (r.ok ? (r.json() as Promise<{ to: string; closedDates: ClosedDates }>) : Promise.reject(new Error(String(r.status)))))
        .then((res) => {
          setClosedDates((prev) => (prev ? mergeClosedDates(prev, res.closedDates) : res.closedDates));
          // Only ever forward: two slices can land out of order.
          setLoadedThrough((prev) => (!prev || res.to > prev ? res.to : prev));
        })
        .catch(() => {
          // Let a later page-forward retry rather than stranding the calendar on
          // a transient failure. The unfetched months stay greyed meanwhile,
          // which is the honest thing to show.
          requested.current = from;
        });
    },
    [base, roomId, horizonEnd],
  );

  return { closedDates, loadedThrough: loadedThrough ?? undefined, extendTo };
}
