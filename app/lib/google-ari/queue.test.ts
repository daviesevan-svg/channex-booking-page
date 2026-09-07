import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryScope } from "../ari/read.server";

const push = vi.hoisted(() => ({ sync: vi.fn(), block: vi.fn() }));
vi.mock("./push.server", () => ({
  performGoogleAriSync: push.sync,
  blockOnGoogle: push.block,
  ALL_SYNC_KINDS: ["property_data", "ari", "taxes", "promotions"],
}));
vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class { constructor(public ctx: unknown) {} },
}));
import { GoogleAriQueue } from "./queue.server";
import { submitGoogleAriWork } from "./queue-client.server";

const ok = [{ kind: "ari", ok: true, detail: "accepted" }];
const bad = [{ kind: "ari", ok: false, detail: "not matched yet" }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => { resolve = r; }), resolve };
}
/** Transaction serialization and durable restart storage; no process-memory
 * queue state is involved. Tests exercise enqueues during actual awaits. */
class Storage {
  state = new Map<string, unknown>();
  alarm: number | null = null;
  private lock = Promise.resolve();
  async transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
    const previous = this.lock;
    const done = deferred<void>();
    this.lock = done.promise;
    await previous;
    const backup = structuredClone(this.state);
    const alarm = this.alarm;
    try { return await fn(this); }
    catch (error) { this.state = backup; this.alarm = alarm; throw error; }
    finally { done.resolve(); }
  }
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.state.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.state.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value: number) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
}
const scope = (date: string): InventoryScope => ({ availability: [{ roomId: "r1", dates: [date] }], products: [] });
const request = (body: unknown, path = "enqueue") => new Request(`https://queue/${path}`, { method: "POST", body: JSON.stringify(body) });
const work = (date: string) => ({ pid: "hotel", kinds: ["ari"], scope: scope(date) });
let storage: Storage;
let queue: GoogleAriQueue;
beforeEach(() => {
  storage = new Storage();
  queue = new GoogleAriQueue({ storage } as never, {} as Env);
  push.sync.mockReset().mockResolvedValue(ok);
  push.block.mockReset().mockResolvedValue(ok);
});

describe("durable Google ARI queue", () => {
  it("coalesces a burst into one persisted scope and one delivery", async () => {
    await Promise.all([queue.fetch(request(work("2026-10-01"))), queue.fetch(request(work("2026-10-03")))]);
    expect(push.sync).not.toHaveBeenCalled();
    expect(storage.alarm).not.toBeNull();
    await queue.alarm();
    expect(push.sync).toHaveBeenCalledTimes(1);
    expect(push.sync.mock.calls[0][2].availability[0].dates).toEqual(["2026-10-01", "2026-10-03"]);
    expect(storage.alarm).toBeNull();
    expect((await storage.get<{ pending?: unknown; inflight?: unknown }>("queue"))?.pending).toBeUndefined();
  });

  it("lets a full catalog change dominate incremental inventory", async () => {
    await queue.fetch(request(work("2026-10-01")));
    await queue.fetch(request({ pid: "hotel", kinds: ["property_data", "ari"] }));
    await queue.alarm();
    expect(push.sync).toHaveBeenCalledWith("hotel", ["property_data", "ari"], undefined);
  });

  it("retains updates arriving during delivery and never sends concurrently", async () => {
    const pending = deferred<typeof ok>();
    const started = deferred<void>();
    push.sync.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    await queue.fetch(request(work("2026-10-01")));
    const first = queue.alarm();
    await started.promise;
    expect(storage.alarm).not.toBeNull(); // persisted crash-recovery wakeup
    await queue.fetch(request(work("2026-10-03")));
    const duplicateAlarm = queue.alarm();
    expect(push.sync).toHaveBeenCalledTimes(1);
    pending.resolve(ok);
    await Promise.all([first, duplicateAlarm]);
    expect(storage.alarm).not.toBeNull();
    await queue.alarm();
    expect(push.sync).toHaveBeenCalledTimes(2);
    expect(push.sync.mock.calls[1][2]).toEqual(scope("2026-10-03"));
    expect(storage.alarm).toBeNull();
  });

  it("retries failures/readiness gates with both the failed and newer cells", async () => {
    const pending = deferred<typeof ok>();
    const started = deferred<void>();
    push.sync.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    await queue.fetch(request(work("2026-10-01")));
    const first = queue.alarm();
    await started.promise;
    await queue.fetch(request(work("2026-10-03")));
    pending.resolve(bad);
    await first;
    expect(storage.alarm).toBeLessThanOrEqual(Date.now() + 1_000);
    await queue.alarm();
    expect(push.sync.mock.calls[1][2].availability[0].dates).toEqual(["2026-10-01", "2026-10-03"]);
    expect(storage.alarm).toBeNull();
  });

  it("retains thrown transport/storage failures and schedules a bounded retry", async () => {
    push.sync.mockRejectedValueOnce(new Error("DB unavailable"));
    await queue.fetch(request(work("2026-10-01")));
    await queue.alarm();
    expect(storage.alarm).toBeGreaterThan(Date.now());
    expect((await storage.get<{ pending?: unknown }>("queue"))?.pending).toBeDefined();
    await queue.alarm();
    expect(push.sync).toHaveBeenCalledTimes(2);
  });

  it("recovers an interrupted inflight delivery after a new instance starts", async () => {
    await storage.put("queue", { revision: 2, attempts: 0, inflight: { ...work("2026-10-01"), revision: 1 }, pending: { ...work("2026-10-03"), revision: 2 } });
    queue = new GoogleAriQueue({ storage } as never, {} as Env);
    await queue.alarm();
    expect(push.sync.mock.calls[0][2].availability[0].dates).toEqual(["2026-10-01", "2026-10-03"]);
    expect(storage.alarm).toBeNull();
  });

  it("serializes a manual sync behind a running change-driven delivery", async () => {
    const pending = deferred<typeof ok>();
    const started = deferred<void>();
    push.sync.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    await queue.fetch(request(work("2026-10-01")));
    const first = queue.alarm();
    await started.promise;
    const manual = queue.fetch(request({ pid: "hotel", kinds: ["ari"] }, "run"));
    pending.resolve(ok);
    await first;
    expect((await (await manual).json()).results).toEqual(ok);
    expect(push.sync).toHaveBeenCalledTimes(2);
    expect(push.sync.mock.calls[1][2]).toBeUndefined();
  });

  it("finishes the current delivery before blocking, and stale notifications cannot reopen it", async () => {
    const pending = deferred<typeof ok>();
    const started = deferred<void>();
    push.sync.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    await queue.fetch(request(work("2026-10-01")));
    const first = queue.alarm();
    await started.promise;
    await queue.fetch(request({ pid: "hotel", kinds: [], transition: "disable" }));
    await queue.fetch(request(work("2026-10-03")));
    expect(push.block).not.toHaveBeenCalled();
    pending.resolve(ok);
    await first;
    await queue.alarm();
    expect(push.block).toHaveBeenCalledTimes(1);
    await queue.fetch(request(work("2026-10-04")));
    await queue.alarm();
    expect(push.sync).toHaveBeenCalledTimes(1);
    await queue.fetch(request({ pid: "hotel", kinds: ["ari"], transition: "enable" }));
    await queue.alarm();
    expect(push.sync.mock.calls[1][2]).toBeUndefined();
  });

  it("never falls back to unordered HTTP when the binding is missing", async () => {
    await expect(submitGoogleAriWork({ pid: "hotel", kinds: ["ari"] })).rejects.toThrow("binding is not configured");
    expect(push.sync).not.toHaveBeenCalled();
  });
});
