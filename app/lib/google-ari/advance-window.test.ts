import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Early Bird / Last Minute on Google: an out-of-window date is stop-sold in the
// feed (the booking page won't sell it), and because the window slides with the
// calendar the feed is refreshed at each hotel's local midnight.

const store = new Map<string, string>();
const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
const sqlite = new DatabaseSync(":memory:");
type Stmt = { sql: string; args: unknown[]; bind: (...a: unknown[]) => Stmt; all: () => Promise<unknown>; first: () => Promise<unknown>; run: () => Promise<unknown> };
const exec = (s: Stmt) => {
  const p = sqlite.prepare(s.sql);
  if (/^\s*(select|with)/i.test(s.sql)) return { results: p.all(...(s.args as never[])) };
  p.run(...(s.args as never[]));
  return { results: [] };
};
const makeStmt = (sql: string): Stmt => ({
  sql,
  args: [],
  bind(...a: unknown[]) {
    this.args = a;
    return this;
  },
  all: async function () {
    return exec(this as unknown as Stmt);
  },
  first: async function () {
    return (exec(this as unknown as Stmt) as { results: unknown[] }).results[0] ?? null;
  },
  run: async function () {
    return exec(this as unknown as Stmt);
  },
});
const fakeD1 = { prepare: (sql: string) => makeStmt(sql), batch: async (stmts: Stmt[]) => stmts.map(exec) };
const submit = vi.hoisted(() => vi.fn());

vi.mock("cloudflare:workers", () => ({ env: { CONFIG_KV: kv, DB: fakeD1 }, waitUntil: () => {} }));
vi.mock("./queue-client.server", () => ({ submitGoogleAriWork: submit }));

const base = { prices: { room1: 100 }, refundable: true, inclusions: [], active: true, createdAt: "2026-01-01" };
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = "2026-06-01";

function setup(rates: object[], settings: object = {}) {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa" }]));
  store.set("settings:p1", JSON.stringify({ currency: "EUR", googleAriPush: true, ...settings }));
  store.set("catalog_rooms:p1", JSON.stringify([{ id: "room1", title: "Double", images: [], maxAdults: 2, maxGuests: 2, facilities: [], position: 0, createdAt: "2026-01-01" }]));
  store.set("catalog_rates:p1", JSON.stringify(rates));
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => submit.mockReset().mockResolvedValue([]));

const stopSellOn = (avail: { start: string; end: string; stopSell: boolean }[], date: string) =>
  avail.find((a) => a.start <= date && a.end >= date)?.stopSell;

describe("Google feed: advance window", () => {
  it("stop-sells dates outside a Last Minute window and keeps the rest open", async () => {
    setup([{ ...base, id: "lm", title: "Last minute", maxAdvanceDays: 3 }]);
    const { collectAri } = await import("./rates.server");
    const { avail } = await collectAri("p1", { from: TODAY, to: addDays(TODAY, 6) });
    expect([0, 3, 4, 6].map((n) => stopSellOn(avail, addDays(TODAY, n)))).toEqual([false, false, true, true]);
  });

  it("stop-sells dates inside an Early Bird minimum", async () => {
    setup([{ ...base, id: "eb", title: "Early bird", minAdvanceDays: 5 }]);
    const { collectAri } = await import("./rates.server");
    const { avail } = await collectAri("p1", { from: TODAY, to: addDays(TODAY, 7) });
    expect([0, 4, 5, 7].map((n) => stopSellOn(avail, addDays(TODAY, n)))).toEqual([true, true, false, false]);
  });

  it("counts from the hotel's today", async () => {
    // Noon UTC on Jun 1 is already Jun 2 in Auckland, so Jun 5 is 3 days away.
    setup([{ ...base, id: "lm", title: "Last minute", maxAdvanceDays: 3 }], { timezone: "Pacific/Auckland" });
    const { collectAri } = await import("./rates.server");
    const { avail } = await collectAri("p1", { from: TODAY, to: addDays(TODAY, 6) });
    expect(stopSellOn(avail, addDays(TODAY, 4))).toBe(false);
    expect(stopSellOn(avail, addDays(TODAY, 5))).toBe(true);
  });
});

describe("Google feed: hotel-midnight refresh", () => {
  // Midnight in Auckland (UTC+12) is 12:00 UTC; the hourly cron fires at :10.
  const at = (iso: string) => new Date(iso);

  it("pushes at the hotel's local hour 0 when a rate has a window", async () => {
    setup([{ ...base, id: "lm", maxAdvanceDays: 3 }], { timezone: "Pacific/Auckland" });
    const { scheduledGoogleAriWindowSync } = await import("./push.server");
    await scheduledGoogleAriWindowSync(at("2026-06-01T12:10:00Z"));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ pid: "p1", kinds: ["ari"] });
  });

  it("does nothing at other hours", async () => {
    setup([{ ...base, id: "lm", maxAdvanceDays: 3 }], { timezone: "Pacific/Auckland" });
    const { scheduledGoogleAriWindowSync } = await import("./push.server");
    for (const h of ["11:10", "13:10", "00:10"]) await scheduledGoogleAriWindowSync(at(`2026-06-01T${h}:00Z`));
    expect(submit).not.toHaveBeenCalled();
  });

  it("skips properties with no window, push off, or only inactive windowed rates", async () => {
    const { scheduledGoogleAriWindowSync } = await import("./push.server");
    const midnightUtc = at("2026-06-01T00:10:00Z");
    setup([{ ...base, id: "std" }]);
    await scheduledGoogleAriWindowSync(midnightUtc);
    setup([{ ...base, id: "lm", maxAdvanceDays: 3 }], { googleAriPush: false });
    await scheduledGoogleAriWindowSync(midnightUtc);
    setup([{ ...base, id: "lm", maxAdvanceDays: 3, active: false }]);
    await scheduledGoogleAriWindowSync(midnightUtc);
    expect(submit).not.toHaveBeenCalled();
  });

  it("fires once a day for a half-hour-offset timezone", async () => {
    setup([{ ...base, id: "lm", maxAdvanceDays: 3 }], { timezone: "Asia/Kolkata" });
    const { scheduledGoogleAriWindowSync } = await import("./push.server");
    let n = 0;
    for (let h = 0; h < 24; h++) {
      await scheduledGoogleAriWindowSync(at(`2026-06-01T${String(h).padStart(2, "0")}:10:00Z`));
      n = submit.mock.calls.length;
    }
    expect(n).toBe(1);
  });
});
