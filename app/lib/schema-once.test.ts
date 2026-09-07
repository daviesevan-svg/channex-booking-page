import { describe, expect, it, vi } from "vitest";

// The schema is created once per isolate, including when the first callers
// arrive together.
//
// The latch used to be a boolean set AFTER awaiting D1, which only makes a
// caller that arrives after the first one has FINISHED skip the work. Every
// request racing the first into a cold isolate — and a deploy makes every
// request that — slipped past the flag while it was still false and sent the
// same CREATE batch again.

let batches = 0;
let fail = false;
let hang = false;

const fakeD1 = {
  prepare: (sql: string) => ({ sql }),
  batch: async () => {
    batches++;
    // Resolve on a later tick, which is the window the boolean left open.
    if (hang) return new Promise(() => {}); // a response that never arrives
    await new Promise((r) => setTimeout(r, 5));
    if (fail) throw new Error("D1 unavailable");
    return [];
  },
};

vi.mock("cloudflare:workers", () => ({ env: { DB: fakeD1 }, waitUntil: () => {} }));

describe("schemaOnce", () => {
  it("sends one batch for callers that arrive together", async () => {
    const { schemaOnce } = await import("./d1.server");
    batches = 0;
    const ensure = schemaOnce((d) => [d.prepare(`CREATE TABLE IF NOT EXISTS t (a TEXT)`)]);

    await Promise.all(Array.from({ length: 8 }, () => ensure()));
    expect(batches).toBe(1);

    // And still one after they have all settled.
    await ensure();
    expect(batches).toBe(1);
  });

  it("does not latch a failure — the next caller retries", async () => {
    const { schemaOnce } = await import("./d1.server");
    batches = 0;
    fail = true;
    const ensure = schemaOnce((d) => [d.prepare(`CREATE TABLE IF NOT EXISTS t (a TEXT)`)]);

    await expect(ensure()).rejects.toThrow("D1 unavailable");
    expect(batches).toBe(1);

    // A latched failure would leave the isolate claiming a schema it never
    // made, and every query against it failing for the isolate's lifetime.
    fail = false;
    await expect(ensure()).resolves.toBeUndefined();
    expect(batches).toBe(2);
  });

  it("does not latch a batch that never responds — it times out and the next caller retries", async () => {
    // 2026-09-07: one lost D1 response to the ARI DDL batch left the promise
    // pending for the life of a warm isolate, and every guest page that reads
    // availability waited on it forever while D1 answered everything else in
    // under a millisecond. Nothing was logged, because nothing completed.
    vi.useFakeTimers();
    try {
      const { schemaOnce, SCHEMA_TIMEOUT_MS } = await import("./d1.server");
      batches = 0;
      hang = true;
      const ensure = schemaOnce((d) => [d.prepare(`CREATE TABLE IF NOT EXISTS t (a TEXT)`)]);

      const first = ensure();
      const second = ensure(); // arrives while the first is still pending: same batch
      const settled = expect(first).rejects.toThrow(/did not respond within/);
      await vi.advanceTimersByTimeAsync(SCHEMA_TIMEOUT_MS + 1);
      await settled;
      await expect(second).rejects.toThrow(/did not respond within/);
      expect(batches).toBe(1);

      // The latch is clear: the next caller sends a fresh batch and succeeds.
      hang = false;
      const third = ensure();
      await vi.advanceTimersByTimeAsync(10);
      await expect(third).resolves.toBeUndefined();
      expect(batches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
