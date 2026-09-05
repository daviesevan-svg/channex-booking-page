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

const fakeD1 = {
  prepare: (sql: string) => ({ sql }),
  batch: async () => {
    batches++;
    // Resolve on a later tick, which is the window the boolean left open.
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
});
