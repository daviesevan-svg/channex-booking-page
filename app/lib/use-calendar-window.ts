// Owns the guest page's slice of calendar availability: what has been loaded so
// far, and fetching the next slice when the picker pages past it.
//
// The loaders read the first few months (see calendar-window.ts) instead of the
// whole thirteen-month horizon. This hook holds that initial slice, hands
// useDateRange the date it runs out at, and extends it on demand.
//
// Two things it has to get right, because a date NOT in `closed` reads as
// BOOKABLE:
//
//   * Coverage may only ever claim dates actually loaded. Slices are therefore
//     fetched one at a time — two in flight at once can land out of order and
//     advance `loadedThrough` over a gap the earlier one hasn't filled yet.
//   * The state belongs to ONE room of ONE property. The guest routes are single
//     modules serving every room and both property mounts, so paging from room A
//     to room B re-runs the loader WITHOUT remounting this hook.
import { useCallback, useMemo, useRef, useState } from "react";

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

/** The slices fetched on top of the loader's own, tagged with the calendar they
 *  were fetched for. */
interface Fetched {
  identity: string;
  closed: ClosedDates | null;
  through: string | null;
}

/** The later of two dates, either of which may be missing. */
const later = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));

export function useCalendarWindow({ base, initial, initialThrough, roomId, horizonEnd }: Args) {
  // Which calendar the fetched slices belong to. `room/:roomId` is one route
  // module for every room, and the two property mounts share theirs, so this is
  // the only thing that can tell room B's page that the slices in state are A's.
  const identity = `${base} ${roomId ?? ""}`;

  const [fetched, setFetched] = useState<Fetched>({ identity, closed: null, through: null });
  // Bumped whenever the calendar changes underneath us, so a response still in
  // flight for the room we just left is dropped rather than merged into the new
  // one.
  const generation = useRef(0);
  // How far coverage reaches, readable outside a render: extendTo can run again
  // (off the queue below) before React has re-rendered with the slice that just
  // landed.
  const coverage = useRef<string | null>(null);
  const inFlight = useRef(false);
  /** The furthest date asked for while this calendar's fetch was running. */
  const queued = useRef<string | null>(null);

  if (fetched.identity !== identity) {
    setFetched({ identity, closed: null, through: null });
    generation.current += 1;
    coverage.current = null;
    // The new calendar must not wait for the previous room's network request.
    // Its completion handlers are generation-guarded below, so they cannot
    // release this calendar's lock or discard its queued extension.
    inFlight.current = false;
    queued.current = null;
  }
  const mine = fetched.identity === identity ? fetched : null;

  // The loader's slice stays authoritative for its own months — it is re-read on
  // every revalidation, while the fetched slices only ever cover dates past it.
  // Memoised because the picker builds its lookup sets on this object's identity.
  const closedDates = useMemo(() => {
    if (!initial) return null;
    return mine?.closed ? mergeClosedDates(initial, mine.closed) : initial;
  }, [initial, mine?.closed]);

  const loadedThrough = later(initialThrough, mine?.through ?? null);
  coverage.current = later(coverage.current, loadedThrough);

  // What extendTo needs, read at call time rather than captured, so the callback
  // itself stays stable — useDateRange holds it in an effect's deps.
  const live = useRef({ base, roomId, horizonEnd });
  live.current = { base, roomId, horizonEnd };

  // Annotated because the body calls itself to drain the queue, which otherwise
  // makes the inferred type circular.
  const extendTo = useCallback<(need: string) => void>((need) => {
    const from = coverage.current;
    if (!from) return; // no availability data at all — nothing to extend
    if (inFlight.current) {
      // One at a time. Whatever is still wanted once this lands is then fetched
      // as a single further window, which keeps every slice contiguous.
      queued.current = later(queued.current, need);
      return;
    }
    const { base, roomId, horizonEnd } = live.current;
    const win = nextCalendarWindow(from, need, horizonEnd);
    if (!win) return;

    const gen = generation.current;
    inFlight.current = true;

    const params = new URLSearchParams({ from: win.from, to: win.to });
    if (roomId) params.set("roomId", roomId);
    fetch(`${base}/calendar?${params}`, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<{ to: string; closedDates: ClosedDates }>) : Promise.reject(new Error(String(r.status)))))
      .then((res) => {
        if (gen !== generation.current) return; // a different calendar by now
        coverage.current = later(coverage.current, res.to);
        setFetched((prev) => ({
          identity: prev.identity,
          closed: prev.closed ? mergeClosedDates(prev.closed, res.closedDates) : res.closedDates,
          through: later(prev.through, res.to),
        }));
      })
      .catch(() => {
        if (gen !== generation.current) return;
        // Coverage stays where it was, so the unfetched months stay greyed —
        // the honest thing to show — and the next page-forward retries them.
        // Dropping the queue keeps a persistent failure from spinning.
        queued.current = null;
      })
      .finally(() => {
        if (gen !== generation.current) return;
        inFlight.current = false;
        const next = queued.current;
        queued.current = null;
        if (next) extendTo(next);
      });
  }, []);

  return { closedDates, loadedThrough: loadedThrough ?? undefined, extendTo };
}
