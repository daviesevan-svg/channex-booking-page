import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1 } from "../test-d1";

const { sqlite, d1 } = makeTestD1();
const reads: { sql: string; args: unknown[]; rows: number }[] = [];
const originalBatch = d1.batch;
d1.batch = async (stmts) => {
  const results = await originalBatch(stmts);
  stmts.forEach((stmt, i) => {
    if (/^SELECT/.test(stmt.sql)) reads.push({ sql: stmt.sql, args: stmt.args, rows: results[i].results.length });
  });
  return results;
};
vi.mock("cloudflare:workers", () => ({ env: { DB: d1, CONFIG_KV: { get: async () => null, put: async () => {} } }, waitUntil: () => {} }));

const change = (type: string, attributes: Record<string, unknown>) => ({ type, attributes: {
  room_type_id: "r1", rate_plan_id: "p1", date_from: "2026-10-01", date_to: "2026-10-01", ...attributes,
} });
async function ingest(changes: ReturnType<typeof change>[]) {
  const { applyChanges } = await import("./ingest.server");
  return applyChanges({ data: [{ attributes: { hotel_code: "h1", changes } }] });
}
beforeEach(async () => {
  const { ensureSchema } = await import("./schema.server");
  await ensureSchema();
  for (const table of ["availability", "rate", "restriction", "ari_log"]) sqlite.exec(`DELETE FROM ${table}`);
  reads.length = 0;
});

describe("channel audit cells", () => {
  it("does no audit reads for restriction-only changes", async () => {
    await ingest([change("restriction_changes", { stop_sell: true })]);
    expect(reads).toHaveLength(0);
    expect(sqlite.prepare("SELECT stop_sell FROM restriction").get()).toEqual({ stop_sell: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ari_log").get()).toEqual({ n: 0 });
  });

  it("reads only the touched availability room and sparse dates", async () => {
    await ingest([change("availability_changes", { room_type_id: "other", availability: 9 })]);
    reads.length = 0;
    await ingest([
      change("availability_changes", { availability: 3 }),
      change("availability_changes", { availability: 4, date_from: "2026-10-03", date_to: "2026-10-03" }),
    ]);
    expect(reads).toHaveLength(2);
    expect(reads.every((r) => r.sql.includes("FROM availability") && r.args.includes("r1") && !r.args.includes("2026-10-02"))).toBe(true);
    expect(reads.map((r) => r.rows)).toEqual([0, 2]);
  });

  it("retains all occupancy rows for the targeted product's displayed-price diff", async () => {
    await ingest([change("restriction_changes", { rates: [
      { occupancy: 1, rate: "90", currency: "GBP" }, { occupancy: 2, rate: "120", currency: "GBP" },
    ] })]);
    sqlite.exec("DELETE FROM ari_log");
    reads.length = 0;
    await ingest([change("restriction_changes", { rates: [{ occupancy: 1, rate: "95", currency: "GBP" }] })]);
    expect(reads).toHaveLength(2);
    expect(reads.every((r) => r.sql.includes("FROM rate") && r.args.includes("p1"))).toBe(true);
    expect(reads.map((r) => r.rows)).toEqual([2, 2]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ari_log").get()).toEqual({ n: 0 });
    await ingest([change("restriction_changes", { rates: [{ occupancy: 2, rate: "130", currency: "GBP" }] })]);
    expect(sqlite.prepare("SELECT old_value, new_value FROM ari_log").get()).toEqual({ old_value: "120", new_value: "130" });
  });

  it("chunks long exact-cell snapshots below D1's 100-bind limit", async () => {
    await ingest([change("availability_changes", { availability: 1, date_to: "2027-10-01" })]);
    expect(reads.length).toBeGreaterThan(2);
    expect(reads.every((r) => r.args.length <= 100)).toBe(true);
    expect(reads.reduce((sum, r) => sum + r.rows, 0)).toBe(366);
  });
});
