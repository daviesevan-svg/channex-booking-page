import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import type { GateReason } from "./catalog.server";

// Max stay: the restriction on the ARRIVAL night caps how long a guest may stay
// from there, exactly as min stay sets the floor. Until 2026-09 the column was
// ingested from Channex and then never read, so a 14-night booking sailed
// through a rate the hotel had capped at 7. This pins the two consumers: the
// booking gate (withhold + say why) and the calendar projection the date
// picker greys check-outs from.
//
// The D1 binding is shimmed onto node:sqlite, as in catalog-stay-inventory.test.ts.

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
const SHORT = { id: "short", title: "Short break", prices: { room1: 100 }, refundable: true, inclusions: [], active: true, createdAt: "2026-01-01" };
const LONG = { id: "long", title: "Flexible", prices: { room1: 120 }, refundable: true, inclusions: [], active: true, createdAt: "2026-01-01" };

const kvData: Record<string, string> = {
  [`catalog_rooms:${PID}`]: JSON.stringify([ROOM]),
  [`catalog_rates:${PID}`]: JSON.stringify([SHORT, LONG]),
  [`settings:${PID}`]: JSON.stringify({ currency: "GBP" }),
  [`promotions:${PID}`]: JSON.stringify([]),
};
const fakeKV = { get: async (k: string) => kvData[k] ?? null, put: async () => {} };

vi.mock("cloudflare:workers", () => ({
  env: { DB: fakeD1, CONFIG_KV: fakeKV },
  waitUntil: () => {},
}));

const DATES = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06"];

async function seed() {
  const { ensureSchema } = await import("./ari/schema.server");
  await ensureSchema();
  for (const d of DATES) {
    sqlite.prepare(`INSERT OR REPLACE INTO availability (hotel_code, room_type_id, date, avail) VALUES (?,?,?,?)`).run(PID, ROOM.id, d, 5);
  }
  const cap = (rateId: string, date: string, maxStay: number) =>
    sqlite
      .prepare(`INSERT OR REPLACE INTO restriction (hotel_code, room_type_id, rate_plan_id, date, max_stay) VALUES (?,?,?,?,?)`)
      .run(PID, ROOM.id, rateId, date, maxStay);
  // Jun 1: both rates capped (2 and 4 nights). Jun 2: only the short rate is.
  cap(SHORT.id, "2026-06-01", 2);
  cap(LONG.id, "2026-06-01", 4);
  cap(SHORT.id, "2026-06-02", 2);
}

const stay = (checkinDate: string, checkoutDate: string) => ({ checkinDate, checkoutDate, currency: "GBP" });

describe("max stay", () => {
  it("withholds a rate for a stay longer than its arrival-date cap, and says why", async () => {
    await seed();
    const { getCatalogRooms } = await import("./catalog.server");
    const reasons: GateReason[] = [];
    const rooms = await getCatalogRooms(PID, stay("2026-06-01", "2026-06-04"), { gate: true, reasons });

    // Three nights: over the short rate's 2, within the flexible rate's 4.
    expect(rooms.map((r) => r.ratePlans.map((p) => p.id))).toEqual([[LONG.id]]);
    expect(reasons).toEqual([
      expect.objectContaining({ roomId: ROOM.id, rateId: SHORT.id, reason: "max_stay", maxNights: 2 }),
    ]);
  });

  it("drops the room entirely when every rate is over its cap", async () => {
    await seed();
    const { getCatalogRooms } = await import("./catalog.server");
    const reasons: GateReason[] = [];
    const rooms = await getCatalogRooms(PID, stay("2026-06-01", "2026-06-06"), { gate: true, reasons });
    expect(rooms).toEqual([]);
    expect(reasons.map((r) => [r.rateId, r.reason, r.maxNights])).toEqual([
      [SHORT.id, "max_stay", 2],
      [LONG.id, "max_stay", 4],
    ]);
  });

  it("sells a stay within the cap, and reads the cap from the arrival night only", async () => {
    await seed();
    const { getCatalogRooms } = await import("./catalog.server");
    const within = await getCatalogRooms(PID, stay("2026-06-01", "2026-06-03"), { gate: true });
    expect(within.map((r) => r.ratePlans.map((p) => p.id))).toEqual([[SHORT.id, LONG.id]]);
    // Arriving Jun 3 (uncapped) for three nights is fine even though earlier
    // nights carry caps — they bind arrivals on those dates, not stays through.
    const later = await getCatalogRooms(PID, stay("2026-06-03", "2026-06-06"), { gate: true });
    expect(later.map((r) => r.ratePlans.map((p) => p.id))).toEqual([[SHORT.id, LONG.id]]);
  });

  it("projects the cap into the calendar only where every bookable rate is capped", async () => {
    await seed();
    const { getCalendarAvailability } = await import("./catalog.server");
    const c = await getCalendarAvailability(PID, "2026-06-01", "2026-06-03");
    // Jun 1: the more generous of the two caps. Jun 2: the flexible rate has no
    // cap, so the date has none. Jun 3: nothing capped.
    expect(c.maxStayArrival).toEqual({ "2026-06-01": 4 });
    expect(c.closed).toEqual([]);
  });
});
