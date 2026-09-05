// @vitest-environment jsdom
//
// The calendar hook's two invariants, driven through React rather than reasoned
// about: coverage must never claim a date that hasn't been loaded, and the state
// must belong to the room currently on screen.
//
// Both matter because the picker treats a date NOT in `closed` as bookable, so
// an over-claimed `loadedThrough` is the difference between "greyed out, ask the
// server" and "offered to the guest".
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCalendarWindow } from "./use-calendar-window";
import type { ClosedDates } from "./channex/types";

// Tells React that act() is legitimate here, which it only assumes under a test
// build otherwise.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const empty = (): ClosedDates => ({
  closed: [],
  closedToArrival: [],
  closedToDeparture: [],
  minStayArrival: {},
  minStayThrough: {},
});

const withClosed = (...dates: string[]): ClosedDates => ({ ...empty(), closed: dates });

type Hook = ReturnType<typeof useCalendarWindow>;
type Props = Parameters<typeof useCalendarWindow>[0];

/** One deferred `fetch` call: the URL asked for, and the handles to answer it. */
interface Call {
  url: string;
  resolve: (body: { to: string; closedDates: ClosedDates }) => Promise<void>;
  reject: () => Promise<void>;
}

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

/** Mount the hook with `props`, holding every fetch open until the test answers
 *  it. Returns the latest hook value, a rerender, and the pending calls. */
function mount(props: Props) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    let settle!: (r: unknown) => void;
    let fail!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      settle = res;
      fail = rej;
    });
    calls.push({
      url: String(url),
      resolve: async (body) => {
        await act(async () => {
          settle({ ok: true, json: async () => body });
        });
      },
      reject: async () => {
        await act(async () => {
          fail(new Error("offline"));
        });
      },
    });
    return promise;
  });

  let latest!: Hook;
  function Probe(p: Props) {
    latest = useCalendarWindow(p);
    return null;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Probe, props)));

  return {
    calls,
    get value() {
      return latest;
    },
    rerender(next: Props) {
      act(() => root!.render(createElement(Probe, next)));
    },
  };
}

const base = "/spilmanhotel";
const horizonEnd = "2027-11-05";

describe("useCalendarWindow coverage", () => {
  it("does not start a second slice while the first is still in flight", async () => {
    const h = mount({ base, initial: empty(), initialThrough: "2026-12-05", horizonEnd });

    act(() => h.value.extendTo("2027-03-05"));
    expect(h.calls).toHaveLength(1);
    // The picker pages on again before the first slice lands.
    act(() => h.value.extendTo("2027-06-05"));
    expect(h.calls).toHaveLength(1);

    // Nothing has arrived, so nothing is claimed.
    expect(h.value.loadedThrough).toBe("2026-12-05");
  });

  it("advances coverage only over slices that actually landed", async () => {
    const h = mount({ base, initial: empty(), initialThrough: "2026-12-05", horizonEnd });

    act(() => h.value.extendTo("2027-03-05"));
    act(() => h.value.extendTo("2027-06-05"));

    // The far slice can only be asked for after the near one is in hand, so the
    // gap this used to open — the June response landing first and carrying
    // coverage over the missing December-to-March slice — has nowhere to come
    // from.
    expect(h.calls).toHaveLength(1);
    await h.calls[0].resolve({ to: "2027-03-05", closedDates: withClosed("2027-01-10") });
    expect(h.value.loadedThrough).toBe("2027-03-05");
    expect(h.value.closedDates?.closed).toEqual(["2027-01-10"]);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].url).toContain("from=2027-03-06");
    await h.calls[1].resolve({ to: "2027-06-05", closedDates: withClosed("2027-04-02") });
    expect(h.value.loadedThrough).toBe("2027-06-05");
    expect(h.value.closedDates?.closed).toEqual(["2027-01-10", "2027-04-02"]);
  });

  it("leaves coverage where it was when a slice fails, and retries on the next page-forward", async () => {
    const h = mount({ base, initial: empty(), initialThrough: "2026-12-05", horizonEnd });

    act(() => h.value.extendTo("2027-03-05"));
    await h.calls[0].reject();
    // Unfetched months stay unknown rather than reading as bookable.
    expect(h.value.loadedThrough).toBe("2026-12-05");

    act(() => h.value.extendTo("2027-03-05"));
    expect(h.calls).toHaveLength(2);
    await h.calls[1].resolve({ to: "2027-03-05", closedDates: withClosed("2027-02-14") });
    expect(h.value.loadedThrough).toBe("2027-03-05");
  });

  it("does not chase a failing window in a loop", async () => {
    const h = mount({ base, initial: empty(), initialThrough: "2026-12-05", horizonEnd });

    act(() => h.value.extendTo("2027-03-05"));
    act(() => h.value.extendTo("2027-06-05"));
    await h.calls[0].reject();
    // The queued follow-up is dropped with the failure; only the picker asking
    // again starts another request.
    expect(h.calls).toHaveLength(1);
  });

  it("extends only once for a repeated ask", async () => {
    const h = mount({ base, initial: empty(), initialThrough: "2026-12-05", horizonEnd });

    act(() => h.value.extendTo("2027-03-05"));
    await h.calls[0].resolve({ to: "2027-03-05", closedDates: empty() });
    // Already covered — the effect that watches loadedThrough re-runs and must
    // not re-ask.
    act(() => h.value.extendTo("2027-03-05"));
    expect(h.calls).toHaveLength(1);
  });
});

describe("useCalendarWindow identity", () => {
  const roomA: Props = { base, initial: withClosed("2026-10-10"), initialThrough: "2026-12-05", roomId: "a", horizonEnd };

  it("drops the previous room's availability when the route swaps rooms", async () => {
    // `room/:roomId` is one route module, so room B renders into room A's hook.
    const h = mount(roomA);
    expect(h.value.closedDates?.closed).toEqual(["2026-10-10"]);

    h.rerender({ ...roomA, initial: withClosed("2026-11-20"), roomId: "b" });
    expect(h.value.closedDates?.closed).toEqual(["2026-11-20"]);
    expect(h.value.loadedThrough).toBe("2026-12-05");
  });

  it("drops extended slices, and their coverage, with the room they belong to", async () => {
    const h = mount(roomA);
    act(() => h.value.extendTo("2027-03-05"));
    await h.calls[0].resolve({ to: "2027-03-05", closedDates: withClosed("2027-01-10") });
    expect(h.value.loadedThrough).toBe("2027-03-05");

    h.rerender({ ...roomA, initial: withClosed("2026-11-20"), roomId: "b" });
    expect(h.value.closedDates?.closed).toEqual(["2026-11-20"]);
    // Room A's three extra months say nothing about room B.
    expect(h.value.loadedThrough).toBe("2026-12-05");
  });

  it("ignores a slice that arrives after the room changed", async () => {
    const h = mount(roomA);
    act(() => h.value.extendTo("2027-03-05"));

    h.rerender({ ...roomA, initial: withClosed("2026-11-20"), roomId: "b" });
    await h.calls[0].resolve({ to: "2027-03-05", closedDates: withClosed("2027-01-10") });

    expect(h.value.closedDates?.closed).toEqual(["2026-11-20"]);
    expect(h.value.loadedThrough).toBe("2026-12-05");
  });

  it("resets across a property change too, where only the base differs", async () => {
    const noRoom: Props = { base, initial: withClosed("2026-10-10"), initialThrough: "2026-12-05", horizonEnd };
    const h = mount(noRoom);
    act(() => h.value.extendTo("2027-03-05"));
    await h.calls[0].resolve({ to: "2027-03-05", closedDates: withClosed("2027-01-10") });

    h.rerender({ ...noRoom, base: "/othertown", initial: withClosed("2026-12-01") });
    expect(h.value.closedDates?.closed).toEqual(["2026-12-01"]);
    expect(h.value.loadedThrough).toBe("2026-12-05");
  });

  it("picks up a revalidated loader slice for the same room", async () => {
    const h = mount(roomA);
    // The layout loader re-ran and the room closed a date since.
    h.rerender({ ...roomA, initial: withClosed("2026-10-10", "2026-10-11") });
    expect(h.value.closedDates?.closed).toEqual(["2026-10-10", "2026-10-11"]);
  });

  it("does nothing at all when the loader had no availability to give", () => {
    const h = mount({ base, initial: null, initialThrough: null, horizonEnd });
    act(() => h.value.extendTo("2027-03-05"));
    expect(h.calls).toEqual([]);
    expect(h.value.closedDates).toBeNull();
    expect(h.value.loadedThrough).toBeUndefined();
  });
});
