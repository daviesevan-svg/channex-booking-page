import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1 } from "../test-d1";
const { sqlite, d1 } = makeTestD1();
const queue = vi.hoisted(() => vi.fn());
vi.mock("./push.server", () => ({ queueGoogleAriPush: queue }));
vi.mock("cloudflare:workers", () => ({ env: { DB: d1, CONFIG_KV: { get: async () => null, put: async () => {} } }, waitUntil: () => {} }));
const { clearGoogleAriRepair, googleAriRepairStatements, retryGoogleAriRepairs } = await import("./repair.server");

beforeEach(() => {
  sqlite.exec("CREATE TABLE IF NOT EXISTS google_ari_repair (pid TEXT PRIMARY KEY, revision TEXT NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0); DELETE FROM google_ari_repair;");
  queue.mockReset().mockResolvedValue(true); // queueGoogleAriPush: true = admitted
});
async function marker(pid: string, revision: string) {
  await d1.batch(googleAriRepairStatements(d1 as never, [pid], revision, 0) as never);
}

describe("Google durable admission repair", () => {
  it("keeps a newer inventory write when clearing an older enqueue acknowledgement", async () => {
    await marker("hotel", "first");
    await marker("hotel", "second");
    await clearGoogleAriRepair("hotel", "first");
    expect(sqlite.prepare("SELECT revision FROM google_ari_repair").get()).toEqual({ revision: "second" });
  });

  it("recovers a failed enqueue using full inventory and clears only successful admission", async () => {
    await marker("hotel", "first");
    queue.mockRejectedValueOnce(new Error("queue offline"));
    await retryGoogleAriRepairs(100);
    expect(sqlite.prepare("SELECT next_attempt FROM google_ari_repair").get()).toEqual({ next_attempt: 60_100 });
    await retryGoogleAriRepairs(101);
    expect(queue).toHaveBeenCalledTimes(1);
    await retryGoogleAriRepairs(60_100);
    expect(queue).toHaveBeenLastCalledWith("hotel", ["ari"]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM google_ari_repair").get()).toEqual({ n: 0 });
  });

  it("preserves a concurrent refresh while the repair enqueue awaits", async () => {
    await marker("hotel", "first");
    queue.mockImplementationOnce(async () => { await marker("hotel", "newer"); });
    await retryGoogleAriRepairs(100);
    expect(sqlite.prepare("SELECT revision FROM google_ari_repair").get()).toEqual({ revision: "newer" });
  });

  it("bounds work to 25 properties per minute, then advances to the rest", async () => {
    await d1.batch(googleAriRepairStatements(d1 as never, Array.from({ length: 30 }, (_, i) => `hotel-${i}`), "rev", 0) as never);
    await retryGoogleAriRepairs(100);
    expect(queue).toHaveBeenCalledTimes(25);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM google_ari_repair").get()).toEqual({ n: 5 });
    await retryGoogleAriRepairs(101);
    expect(queue).toHaveBeenCalledTimes(30);
  });

  it("commits the repair marker in the same batch as webhook inventory writes", async () => {
    const original = d1.batch;
    const batches: string[][] = [];
    const capture = vi.spyOn(d1, "batch").mockImplementation(async (stmts) => {
      batches.push(stmts.map((s) => s.sql));
      return original(stmts);
    });
    try {
      const { applyChanges } = await import("../ari/ingest.server");
      await applyChanges({ data: [{ attributes: { hotel_code: "hotel", changes: [{ type: "availability_changes", attributes: { room_type_id: "room", date_from: "2026-10-01", date_to: "2026-10-01", availability: 0 } }] } }] }, { repairRevision: "atomic" });
      const writes = batches.filter((batch) => batch.some((sql) => sql.startsWith("INSERT INTO availability")));
      expect(writes).toHaveLength(1);
      expect(writes[0].some((sql) => sql.includes("INSERT INTO google_ari_repair"))).toBe(true);
      expect(sqlite.prepare("SELECT revision FROM google_ari_repair").get()).toEqual({ revision: "atomic" });
    } finally { capture.mockRestore(); }
  });
});
