import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// End-to-end save path for a Channex ARI push, against a REAL SQLite database:
// the actual applyChanges → RATE_UPSERT SQL → getInventoryOn round trip, not a
// re-statement of the arithmetic. The fraction unit test can't catch a bug in
// the binding order, the upsert SQL, or a decode the read path does on its own
// — this can. The D1 binding is shimmed onto node:sqlite (D1 IS SQLite); only
// prepare().bind() and batch() are implemented because that is all the ARI
// paths use.

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
const fakeKV = { get: async () => null, put: async () => {} };

vi.mock("cloudflare:workers", () => ({
  env: { DB: fakeD1, CONFIG_KV: fakeKV },
  waitUntil: () => {},
}));

/** A changes_notification body exactly as Channex POSTs it to /api/changes. */
const push = (rate: { rate: string; currency: string; fraction_size: number }, date: string) => ({
  data: [
    {
      type: "changes_notification",
      attributes: {
        request_id: "test",
        hotel_code: "h1",
        changes: [
          {
            type: "restriction_changes",
            attributes: {
              room_type_id: "room",
              rate_plan_id: "plan",
              date_from: date,
              date_to: date,
              rates: [{ ...rate, occupancy: 2 }],
            },
          },
        ],
      },
    },
  ],
});

describe("Channex ARI push round trip", () => {
  it("keeps a VND (fraction_size 0) rate whole through store, read and audit log", async () => {
    const { applyChanges } = await import("./ingest.server");
    const { getInventoryOn } = await import("./read.server");

    const counts = await applyChanges(push({ rate: "500000", currency: "VND", fraction_size: 0 }, "2026-09-01"));
    expect(counts.rates).toBe(1);

    const row = sqlite
      .prepare("SELECT price_minor, currency, fraction_size FROM rate WHERE date='2026-09-01'")
      .get() as { price_minor: number; currency: string; fraction_size: number };
    expect(row).toEqual({ price_minor: 500_000, currency: "VND", fraction_size: 0 });

    const inv = await getInventoryOn("h1", ["2026-09-01"]);
    expect(inv.prices["room|plan|2026-09-01"]).toBe(500_000);
    expect(inv.pricesByOcc["room|plan|2026-09-01"]).toEqual({ 2: 500_000 });

    // The audit log's diff decodes through the same read path — the logged
    // new_value is the major-unit price the guest will see.
    const log = sqlite
      .prepare("SELECT new_value FROM ari_log WHERE kind='price' AND date='2026-09-01'")
      .get() as { new_value: string };
    expect(log.new_value).toBe("500000");
  });

  it("still scales two-decimal rates by 100 (the common case)", async () => {
    const { applyChanges } = await import("./ingest.server");
    const { getInventoryOn } = await import("./read.server");

    await applyChanges(push({ rate: "198.00", currency: "GBP", fraction_size: 2 }, "2026-09-02"));

    const row = sqlite
      .prepare("SELECT price_minor, fraction_size FROM rate WHERE date='2026-09-02'")
      .get() as { price_minor: number; fraction_size: number };
    expect(row).toEqual({ price_minor: 19_800, fraction_size: 2 });

    const inv = await getInventoryOn("h1", ["2026-09-02"]);
    expect(inv.prices["room|plan|2026-09-02"]).toBe(198);
  });

  it("re-pushing the same VND rate is a no-op, not a re-scale", async () => {
    const { applyChanges } = await import("./ingest.server");
    const { getInventoryOn } = await import("./read.server");

    const body = push({ rate: "500000", currency: "VND", fraction_size: 0 }, "2026-09-03");
    await applyChanges(body);
    await applyChanges(body);

    const inv = await getInventoryOn("h1", ["2026-09-03"]);
    expect(inv.prices["room|plan|2026-09-03"]).toBe(500_000);
  });
});
