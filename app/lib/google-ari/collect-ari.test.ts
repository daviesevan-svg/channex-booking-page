import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// Google ARI payload building: what these pin is that a rate push can NEVER
// carry a non-positive amount. Google rejects the WHOLE OTA rate message
// (Status="NotProcessed", error 450 "`AmountBeforeTax` and `AmountAfterTax`
// must be positive") when any BaseByGuestAmt is 0 — one poisoned date stalls
// every price in the push. The two real-world zero sources are seeded through
// the REAL Channex ingest (rate "0" on a closeout) and a rate-wide occupancy
// discount at the base price.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

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
    const r = exec(this as unknown as Stmt) as { results: unknown[] };
    return r.results[0] ?? null;
  },
  run: async function () {
    return exec(this as unknown as Stmt);
  },
});
const fakeD1 = {
  prepare: (sql: string) => makeStmt(sql),
  batch: async (stmts: Stmt[]) => stmts.map(exec),
};

vi.mock("cloudflare:workers", () => ({
  env: { CONFIG_KV: kv, DB: fakeD1 },
  waitUntil: () => {},
}));

async function seed() {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa Test" }]));
  store.set("settings:p1", JSON.stringify({ currency: "EUR" }));
  store.set(
    "catalog_rooms:p1",
    JSON.stringify([{ id: "room1", title: "Double", images: [], maxAdults: 2, maxGuests: 2, facilities: [], position: 0, createdAt: "2026-01-01" }]),
  );
  store.set(
    "catalog_rates:p1",
    JSON.stringify([
      { id: "rate1", title: "BAR", prices: { room1: 100 }, refundable: true, inclusions: [], active: true, createdAt: "2026-01-01" },
      {
        id: "rate2",
        title: "Solo killer",
        prices: { room1: 100 },
        // Discount equals the base: a single guest prices to exactly 0.
        occupancyPricing: { defaultOccupancy: 2, lessGuestDiscount: 100 },
        refundable: true,
        inclusions: [],
        active: true,
        createdAt: "2026-01-01",
      },
    ]),
  );

  // Real Channex ingest: day 1 priced normally, day 2 a rate-0 closeout.
  const { applyChanges } = await import("../ari/ingest.server");
  await applyChanges({
    data: [
      {
        type: "changes_notification",
        attributes: {
          hotel_code: "p1",
          changes: [
            {
              type: "restriction_changes",
              attributes: { room_type_id: "room1", rate_plan_id: "rate1", date_from: "2026-10-01", date_to: "2026-10-01", rates: [{ rate: "120", currency: "EUR" }] },
            },
            {
              type: "restriction_changes",
              attributes: { room_type_id: "room1", rate_plan_id: "rate1", date_from: "2026-10-02", date_to: "2026-10-02", rates: [{ rate: "0", currency: "EUR" }] },
            },
          ],
        },
      },
    ],
  });
}
const seeded = seed();

describe("Google ARI rate amounts", () => {
  it("never emits a non-positive amount: a rate-0 D1 day is omitted and stop-sold instead", async () => {
    await seeded;
    const { collectAri } = await import("./rates.server");
    const { rates, avail } = await collectAri("p1", { from: "2026-10-01", to: "2026-10-03" });

    const r1 = rates.filter((r) => r.rateId === "rate1");
    // Day 1: the ingested 120. Day 3: the catalog base 100. Day 2: NOTHING.
    expect(r1.map((r) => `${r.start}..${r.end}=${r.amounts[0]?.gross}`)).toEqual([
      "2026-10-01..2026-10-01=120",
      "2026-10-03..2026-10-03=100",
    ]);
    for (const r of rates) for (const a of r.amounts) {
      expect(a.net).toBeGreaterThan(0);
      expect(a.gross).toBeGreaterThan(0);
    }

    // The unpriced day reads CLOSED — not open at a stale price.
    const a1 = avail.filter((a) => a.rateId === "rate1");
    expect(a1.find((a) => a.start <= "2026-10-02" && a.end >= "2026-10-02")?.stopSell).toBe(true);
    expect(a1.find((a) => a.start <= "2026-10-01" && a.end >= "2026-10-01")?.stopSell).toBe(false);
    expect(a1.find((a) => a.start <= "2026-10-03" && a.end >= "2026-10-03")?.stopSell).toBe(false);
  });

  it("drops only the zero-priced guest count when other occupancies still price", async () => {
    await seeded;
    const { collectAri } = await import("./rates.server");
    const { rates, avail } = await collectAri("p1", { from: "2026-10-03", to: "2026-10-03" });

    const r2 = rates.find((r) => r.rateId === "rate2")!;
    // Guest 1 priced 100 - 100 = 0 → omitted; guest 2 stays.
    expect(r2.amounts).toEqual([{ guests: 2, net: 100, gross: 100 }]);
    // Some occupancy still prices, so the date stays open.
    expect(avail.find((a) => a.rateId === "rate2")?.stopSell).toBe(false);
  });
});
