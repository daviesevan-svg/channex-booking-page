import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { advanceMiss, parseAdvanceDays, validateAdvanceWindow } from "./advance-window";
import type { GateReason } from "./catalog.server";

// Advance-purchase window on a rate plan: Last Minute (max days before arrival)
// and Early Bird (min days before arrival). The booking gate withholds the rate
// outside its window and says why; the calendar closes a date when NO rate is in
// window for it. "Today" is the hotel's today, in the hotel's timezone.
//
// The D1 binding is shimmed onto node:sqlite, as in catalog-max-stay.test.ts.

const sqlite = new DatabaseSync(":memory:");
type Stmt = { sql: string; args: unknown[]; bind: (...a: unknown[]) => Stmt };
const makeStmt = (sql: string): Stmt => ({
  sql,
  args: [],
  bind(...a: unknown[]) {
    this.args = a;
    return this;
  },
});
const fakeD1 = {
  prepare: (sql: string) => makeStmt(sql),
  batch: async (stmts: Stmt[]) =>
    stmts.map((s) => {
      const p = sqlite.prepare(s.sql);
      if (/^\s*(select|with)/i.test(s.sql)) return { results: p.all(...(s.args as never[])) };
      p.run(...(s.args as never[]));
      return { results: [] };
    }),
};

const PID = "h1";
const ROOM = { id: "room1", title: "Double", images: [], maxAdults: 2, maxGuests: 2, facilities: [], position: 0, createdAt: "2026-01-01" };
const base = { prices: { room1: 100 }, refundable: true, inclusions: [], active: true, createdAt: "2026-01-01" };
const STANDARD = { ...base, id: "std", title: "Standard" };
const LAST_MINUTE = { ...base, id: "lm", title: "Last minute", maxAdvanceDays: 3 };
const EARLY_BIRD = { ...base, id: "eb", title: "Early bird", minAdvanceDays: 30 };
const SAME_DAY = { ...base, id: "sd", title: "Tonight only", maxAdvanceDays: 0 };

const kvData: Record<string, string> = {};
const setRates = (rates: unknown[], settings: object = {}) => {
  kvData[`catalog_rooms:${PID}`] = JSON.stringify([ROOM]);
  kvData[`catalog_rates:${PID}`] = JSON.stringify(rates);
  kvData[`settings:${PID}`] = JSON.stringify({ currency: "GBP", ...settings });
  kvData[`promotions:${PID}`] = JSON.stringify([]);
};
const fakeKV = { get: async (k: string) => kvData[k] ?? null, put: async () => {} };

vi.mock("cloudflare:workers", () => ({
  env: { DB: fakeD1, CONFIG_KV: fakeKV },
  waitUntil: () => {},
}));

// Today, for the hotel and the server alike: 2026-06-01 at noon UTC.
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = "2026-06-01";
const inDays = (n: number) => addDays(TODAY, n);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  const { ensureSchema } = await import("./ari/schema.server");
  await ensureSchema();
  for (let i = 0; i <= 60; i++) {
    sqlite.prepare(`INSERT OR REPLACE INTO availability (hotel_code, room_type_id, date, avail) VALUES (?,?,?,?)`).run(PID, ROOM.id, inDays(i), 5);
  }
});
afterAll(() => vi.useRealTimers());

const stay = (n: number) => ({ checkinDate: inDays(n), checkoutDate: inDays(n + 1), currency: "GBP" });
const ids = (rooms: { ratePlans: { id: string }[] }[]) => rooms.flatMap((r) => r.ratePlans.map((p) => p.id));

describe("advance window (pure)", () => {
  it("treats both bounds as inclusive", () => {
    expect(advanceMiss({ maxAdvanceDays: 3 }, 3)).toBeNull();
    expect(advanceMiss({ maxAdvanceDays: 3 }, 4)).toBe("max_advance");
    expect(advanceMiss({ minAdvanceDays: 30 }, 30)).toBeNull();
    expect(advanceMiss({ minAdvanceDays: 30 }, 29)).toBe("min_advance");
    expect(advanceMiss({}, 400)).toBeNull();
  });

  it("keeps 0 as a real maximum and blank as no limit", () => {
    expect(advanceMiss({ maxAdvanceDays: 0 }, 0)).toBeNull();
    expect(advanceMiss({ maxAdvanceDays: 0 }, 1)).toBe("max_advance");
    expect(parseAdvanceDays("0")).toBe(0);
    expect(parseAdvanceDays("")).toBeUndefined();
    expect(parseAdvanceDays(null)).toBeUndefined();
    expect(parseAdvanceDays("-1")).toBeNaN();
    expect(parseAdvanceDays("2.5")).toBeNaN();
    expect(parseAdvanceDays("abc")).toBeNaN();
  });

  it("rejects a minimum above the maximum", () => {
    expect(validateAdvanceWindow({ minAdvanceDays: 10, maxAdvanceDays: 5 })).toBe("min_gt_max");
    expect(validateAdvanceWindow({ minAdvanceDays: 5, maxAdvanceDays: 5 })).toBeNull();
    expect(validateAdvanceWindow({ minAdvanceDays: 5 })).toBeNull();
  });
});

describe("advance window (booking gate)", () => {
  it("shows a Last Minute rate only for arrivals inside its maximum, and says why otherwise", async () => {
    setRates([STANDARD, LAST_MINUTE]);
    const { getCatalogRooms } = await import("./catalog.server");
    expect(ids(await getCatalogRooms(PID, stay(2), { gate: true }))).toEqual(["std", "lm"]);
    expect(ids(await getCatalogRooms(PID, stay(3), { gate: true }))).toEqual(["std", "lm"]);
    const reasons: GateReason[] = [];
    expect(ids(await getCatalogRooms(PID, stay(4), { gate: true, reasons }))).toEqual(["std"]);
    expect(reasons).toEqual([expect.objectContaining({ rateId: "lm", reason: "max_advance", advanceDays: 3, daysAhead: 4 })]);
  });

  it("shows an Early Bird rate only for arrivals beyond its minimum", async () => {
    setRates([STANDARD, EARLY_BIRD]);
    const { getCatalogRooms } = await import("./catalog.server");
    const reasons: GateReason[] = [];
    expect(ids(await getCatalogRooms(PID, stay(29), { gate: true, reasons }))).toEqual(["std"]);
    expect(reasons).toEqual([expect.objectContaining({ rateId: "eb", reason: "min_advance", advanceDays: 30, daysAhead: 29 })]);
    expect(ids(await getCatalogRooms(PID, stay(30), { gate: true }))).toEqual(["std", "eb"]);
  });

  it("a maximum of 0 sells same-day arrivals only", async () => {
    setRates([SAME_DAY]);
    const { getCatalogRooms } = await import("./catalog.server");
    expect(ids(await getCatalogRooms(PID, stay(0), { gate: true }))).toEqual(["sd"]);
    expect(ids(await getCatalogRooms(PID, stay(1), { gate: true }))).toEqual([]);
  });

  it("does not gate a completed booking (no gate flag)", async () => {
    setRates([LAST_MINUTE]);
    const { getCatalogRooms } = await import("./catalog.server");
    expect(ids(await getCatalogRooms(PID, stay(40)))).toEqual(["lm"]);
  });

  it("counts days from the hotel's today, not the server's", async () => {
    // 12:00 UTC on Jun 1 is already 00:00 on Jun 2 in Auckland (UTC+12), so a
    // Jun 5 arrival is 3 days away there but 4 by the server's clock.
    setRates([LAST_MINUTE], { timezone: "Pacific/Auckland" });
    const { getCatalogRooms } = await import("./catalog.server");
    expect(ids(await getCatalogRooms(PID, stay(4), { gate: true }))).toEqual(["lm"]);
    setRates([LAST_MINUTE], { timezone: "UTC" });
    expect(ids(await getCatalogRooms(PID, stay(4), { gate: true }))).toEqual([]);
  });
});

describe("advance window (calendar)", () => {
  it("closes a date when the only rate on sale is outside its window", async () => {
    setRates([LAST_MINUTE]);
    const { getCalendarAvailability } = await import("./catalog.server");
    const c = await getCalendarAvailability(PID, inDays(0), inDays(6));
    expect(c.closed).toEqual([inDays(4), inDays(5), inDays(6)]);
  });

  it("keeps the date open while any rate is in window", async () => {
    setRates([STANDARD, LAST_MINUTE, EARLY_BIRD]);
    const { getCalendarAvailability } = await import("./catalog.server");
    const c = await getCalendarAvailability(PID, inDays(0), inDays(35));
    expect(c.closed).toEqual([]);
  });

  it("an Early Bird–only property is closed until its window opens", async () => {
    setRates([EARLY_BIRD]);
    const { getCalendarAvailability } = await import("./catalog.server");
    const c = await getCalendarAvailability(PID, inDays(27), inDays(31));
    expect(c.closed).toEqual([inDays(27), inDays(28), inDays(29)]);
  });
});
