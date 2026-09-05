import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// Cart pricing reads the ARI ONCE, whatever the cart's mix of occupancies.
//
// resolveCartByOccupancy groups the lines by party size and prices each group
// through getCatalogRooms. Each of those used to read availability, rate and
// restriction from D1 again — same property, same dates — so a three-occupancy
// cart re-read the same slice three times, sequentially. It now loads one
// snapshot and hands it to every group.
//
// Counting the reads is only half of it: sharing a snapshot must NOT collapse
// the occupancies into one price, which is exactly what a careless "load it
// once" would do. So this also asserts each line keeps its OWN party's price,
// against a real SQLite database holding per-occupancy rate rows.
//
// The D1 binding is shimmed onto node:sqlite (D1 IS SQLite), as in
// ari/ingest-roundtrip.test.ts; only prepare().bind() and batch() are
// implemented because that is all the ARI paths use.

const sqlite = new DatabaseSync(":memory:");

/** SELECTs issued against the availability table — one per inventory read. */
let availabilityReads = 0;

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
      if (/^\s*(select|with)/i.test(s.sql)) {
        if (/from\s+availability/i.test(s.sql)) availabilityReads++;
        return { results: p.all(...(s.args as never[])) };
      }
      p.run(...(s.args as never[]));
      return { results: [] };
    }),
};

const PID = "h1";
const ROOM = { id: "room1", title: "Double", images: [], maxAdults: 3, maxGuests: 3, facilities: [], position: 0, createdAt: "2026-01-01" };
const RATE = { id: "rate1", title: "Room only", prices: { room1: 100 }, refundable: true, inclusions: [], active: true, createdAt: "2026-01-01" };

const kvData: Record<string, string> = {
  [`catalog_rooms:${PID}`]: JSON.stringify([ROOM]),
  [`catalog_rates:${PID}`]: JSON.stringify([RATE]),
  // Per-person pricing, so each occupancy resolves through its own ARI row.
  [`settings:${PID}`]: JSON.stringify({ pricingMode: "per_person", currency: "GBP" }),
  [`promotions:${PID}`]: JSON.stringify([]),
};
const fakeKV = { get: async (k: string) => kvData[k] ?? null, put: async () => {} };

vi.mock("cloudflare:workers", () => ({
  env: { DB: fakeD1, CONFIG_KV: fakeKV },
  waitUntil: () => {},
}));

const NIGHTS = ["2026-06-01", "2026-06-02"];
const CHECKIN = NIGHTS[0];
const CHECKOUT = "2026-06-03";
// Deliberately NOT a multiple of one another, so a per-adult multiplication
// could not accidentally reproduce them.
const PRICE_BY_OCCUPANCY: Record<number, number> = { 1: 80, 2: 130, 3: 165 };

async function seed() {
  const { ensureSchema } = await import("./ari/schema.server");
  await ensureSchema();
  for (const d of [...NIGHTS, CHECKOUT]) {
    sqlite.prepare(`INSERT OR REPLACE INTO availability (hotel_code, room_type_id, date, avail) VALUES (?,?,?,?)`).run(PID, ROOM.id, d, 5);
    for (const [occ, price] of Object.entries(PRICE_BY_OCCUPANCY)) {
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO rate (hotel_code, room_type_id, rate_plan_id, date, occupancy, price_minor, currency, fraction_size)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(PID, ROOM.id, RATE.id, d, Number(occ), price * 100, "GBP", 2);
    }
  }
}

describe("cart pricing across several occupancies", () => {
  it("reads the inventory once and still prices every line from its own party", async () => {
    await seed();
    const { resolveCartByOccupancy } = await import("./catalog.server");

    availabilityReads = 0;
    const lines = await resolveCartByOccupancy(
      PID,
      { checkin: CHECKIN, checkout: CHECKOUT, currency: "GBP" },
      [
        { roomId: ROOM.id, rateId: RATE.id, adults: 1, childrenAge: [] },
        { roomId: ROOM.id, rateId: RATE.id, adults: 3, childrenAge: [] },
        { roomId: ROOM.id, rateId: RATE.id, adults: 2, childrenAge: [] },
        // A repeat of an occupancy already in the cart — grouped, not re-read.
        { roomId: ROOM.id, rateId: RATE.id, adults: 1, childrenAge: [] },
      ],
      { adults: 2, childrenAge: [] },
    );

    // Four lines, three distinct occupancies, ONE read of the slice.
    expect(availabilityReads).toBe(1);

    expect(lines).toHaveLength(4);
    // Two nights at that party's own nightly price — not one price repeated.
    const total = (adults: number) => PRICE_BY_OCCUPANCY[adults] * NIGHTS.length;
    expect(lines.map((l) => l.total)).toEqual([total(1), total(3), total(2), total(1)]);
  });

  it("reuses a snapshot the caller already loaded, and reads nothing for an empty cart", async () => {
    await seed();
    const { getStayInventory, resolveCartByOccupancy } = await import("./catalog.server");

    availabilityReads = 0;
    const inventory = await getStayInventory(PID, CHECKIN, CHECKOUT);
    expect(availabilityReads).toBe(1);

    // The page loaded the slice; pricing the cart adds no read of its own.
    await resolveCartByOccupancy(
      PID,
      { checkin: CHECKIN, checkout: CHECKOUT, currency: "GBP" },
      [{ roomId: ROOM.id, rateId: RATE.id, adults: 2, childrenAge: [] }],
      { adults: 2, childrenAge: [] },
      inventory,
    );
    expect(availabilityReads).toBe(1);

    // An empty cart has nothing to price, so it reads nothing at all.
    await resolveCartByOccupancy(PID, { checkin: CHECKIN, checkout: CHECKOUT, currency: "GBP" }, [], { adults: 2, childrenAge: [] });
    expect(availabilityReads).toBe(1);
  });

  it("ignores a snapshot loaded for different dates rather than pricing the wrong stay", async () => {
    await seed();
    const { getStayInventory, resolveCartByOccupancy } = await import("./catalog.server");

    // A snapshot for a stay that has no inventory at all.
    const wrong = await getStayInventory(PID, "2026-07-01", "2026-07-03");
    availabilityReads = 0;
    const lines = await resolveCartByOccupancy(
      PID,
      { checkin: CHECKIN, checkout: CHECKOUT, currency: "GBP" },
      [{ roomId: ROOM.id, rateId: RATE.id, adults: 2, childrenAge: [] }],
      { adults: 2, childrenAge: [] },
      wrong,
    );

    // Read fresh for the real dates — a mismatched window is never trusted.
    expect(availabilityReads).toBe(1);
    expect(lines.map((l) => l.total)).toEqual([PRICE_BY_OCCUPANCY[2] * NIGHTS.length]);
  });
});
