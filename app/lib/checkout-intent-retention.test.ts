import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1 } from "./test-d1";

const { sqlite, d1 } = makeTestD1();
vi.mock("cloudflare:workers", () => ({ env: { DB: d1 }, waitUntil: () => {} }));

const now = Date.parse("2026-09-07T12:00:00Z");
const stamp = (hours: number) => new Date(now - hours * 3600_000).toISOString();
const add = (fingerprint: string, hours: number) => sqlite.prepare(
  "INSERT INTO checkout_intent VALUES (?,?,?,?)",
).run("hotel", fingerprint, `REF-${fingerprint}`, stamp(hours));

beforeEach(async () => {
  const { pruneCheckoutIntents } = await import("./checkout-idem.server");
  await pruneCheckoutIntents(now);
  sqlite.exec("DELETE FROM checkout_intent");
});

describe("temporary checkout intent retention", () => {
  it("removes expired intents while retaining active, grace-period and boundary claims", async () => {
    add("expired", 25);
    add("active", 1);
    add("grace", 10);
    add("boundary", 24);
    const { pruneCheckoutIntents } = await import("./checkout-idem.server");
    expect(await pruneCheckoutIntents(now)).toBe(1);
    expect(sqlite.prepare("SELECT fingerprint FROM checkout_intent ORDER BY fingerprint").all()).toEqual([
      { fingerprint: "active" }, { fingerprint: "boundary" }, { fingerprint: "grace" },
    ]);
  });

  it("preserves an expired fingerprint refreshed before cleanup", async () => {
    add("refreshed", 48);
    const { claimCheckoutReference, pruneCheckoutIntents } = await import("./checkout-idem.server");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const reference = await claimCheckoutReference("hotel", "refreshed");
      expect(await pruneCheckoutIntents(now)).toBe(0);
      expect(sqlite.prepare("SELECT reference FROM checkout_intent").get()).toEqual({ reference });
    } finally { vi.useRealTimers(); }
  });

  it("persists a shared reference when cleanup wins between conflict and refresh", async () => {
    add("racing", 48);
    const { claimCheckoutReference, pruneCheckoutIntents } = await import("./checkout-idem.server");
    const originalPrepare = d1.prepare.bind(d1);
    let pruned = false;
    const prepare = vi.spyOn(d1, "prepare").mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      if (sql.includes("UPDATE checkout_intent SET reference")) {
        const run = statement.run.bind(statement);
        statement.run = async () => {
          if (!pruned) {
            pruned = true;
            expect(await pruneCheckoutIntents(now)).toBe(1);
          }
          return run();
        };
      }
      return statement;
    });
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const first = await claimCheckoutReference("hotel", "racing");
      expect(sqlite.prepare("SELECT reference FROM checkout_intent").get()).toEqual({ reference: first });
      expect(await claimCheckoutReference("hotel", "racing")).toBe(first);
    } finally {
      prepare.mockRestore();
      vi.useRealTimers();
    }
  });

  it("bounds each invocation and continues a backlog on the next run", async () => {
    sqlite.exec("BEGIN");
    for (let i = 0; i < 5001; i++) add(`old-${i}`, 48);
    sqlite.exec("COMMIT");
    const { pruneCheckoutIntents } = await import("./checkout-idem.server");
    expect(await pruneCheckoutIntents(now)).toBe(5000);
    expect(await pruneCheckoutIntents(now)).toBe(1);
    expect(await pruneCheckoutIntents(now)).toBe(0);
  });
});
