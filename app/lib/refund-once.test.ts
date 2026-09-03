import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// Money goes back out once. Pins, against a REAL SQLite behind the D1 shim:
// the refund claim is a latch (second caller loses, a released claim can be
// re-won), cancelBookingIfActive flips exactly one of two racing cancels, and
// refundBookingCharge calls the gateway once for a Viva booking however many
// times it is invoked — Viva has no idempotency key, so this latch is the only
// thing between a double cancel and a double refund.

const sqlite = new DatabaseSync(":memory:");

type Stmt = { sql: string; args: unknown[]; bind: (...a: unknown[]) => Stmt; run: () => Promise<unknown>; first: <T>() => Promise<T | null>; all: <T>() => Promise<{ results: T[] }> };
const makeStmt = (sql: string): Stmt => ({
  sql,
  args: [],
  bind(...a: unknown[]) {
    this.args = a;
    return this;
  },
  async run() {
    const info = sqlite.prepare(this.sql).run(...(this.args as never[]));
    return { success: true, meta: { changes: Number(info.changes) } };
  },
  async first<T>() {
    return (sqlite.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null;
  },
  async all<T>() {
    return { results: sqlite.prepare(this.sql).all(...(this.args as never[])) as T[] };
  },
});
const fakeD1 = {
  prepare: (sql: string) => makeStmt(sql),
  batch: async (stmts: Stmt[]) =>
    stmts.map((s) => {
      const p = sqlite.prepare(s.sql);
      if (/^\s*(select|with)/i.test(s.sql)) return { results: p.all(...(s.args as never[])) };
      const info = p.run(...(s.args as never[]));
      return { results: [], meta: { changes: Number(info.changes) } };
    }),
};
const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

vi.mock("cloudflare:workers", () => ({
  env: { DB: fakeD1, CONFIG_KV: kv },
  waitUntil: () => {},
}));

// The gateway: count calls, succeed.
const vivaCalls: unknown[][] = [];
vi.mock("./viva.server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./viva.server")>();
  return {
    ...mod,
    vivaRefund: async (...args: unknown[]) => {
      vivaCalls.push(args);
      return { Success: true, StatusId: "F", TransactionId: "rf_1", Amount: 120 };
    },
  };
});

const PID = "p1";
store.set(`viva_config:${PID}`, JSON.stringify({ merchantId: "m", apiKey: "k", clientId: "c", clientSecret: "s", sourceCode: "1", demo: true }));

describe("claimRefund", () => {
  it("lets exactly one caller through, and a released claim can be won again", async () => {
    const { claimRefund, releaseRefundClaim } = await import("./refund-claim.server");
    expect(await claimRefund("booking:p1:b-claim")).toBe(true);
    expect(await claimRefund("booking:p1:b-claim")).toBe(false);
    await releaseRefundClaim("booking:p1:b-claim");
    expect(await claimRefund("booking:p1:b-claim")).toBe(true);
  });
});

describe("cancelBookingIfActive", () => {
  it("flips active→cancelled for one of two racing cancels only", async () => {
    const { claimBooking, cancelBookingIfActive, getBooking } = await import("./bookings.server");
    const draft = {
      id: "b-race",
      reference: "RACE0001",
      status: "confirmed",
      createdAt: "2026-09-02T00:00:00Z",
      checkin: "2026-10-01",
      checkout: "2026-10-03",
      nights: 2,
      rooms: [],
      total: 120,
      currency: "EUR",
      guest: { firstName: "A", lastName: "B", email: "a@example.com", phone: "" },
      inventoryHeld: true,
    } as never;
    expect((await claimBooking(PID, draft)).won).toBe(true);

    const [first, second] = await Promise.all([
      cancelBookingIfActive(PID, "b-race", { cancelledAt: "t1" }),
      cancelBookingIfActive(PID, "b-race", { cancelledAt: "t2" }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const stored = await getBooking(PID, "b-race");
    expect(stored?.lifecycle).toBe("cancelled");
    // And a later cancel is a no-op.
    expect(await cancelBookingIfActive(PID, "b-race", { cancelledAt: "t3" })).toBeUndefined();
  });
});

describe("refundBookingCharge (Viva)", () => {
  it("hits the gateway once no matter how many callers arrive together", async () => {
    const { claimBooking, getBooking } = await import("./bookings.server");
    const { refundBookingCharge } = await import("./refunds.server");
    const draft = {
      id: "b-refund",
      reference: "REFUND01",
      status: "confirmed",
      createdAt: "2026-09-02T00:00:00Z",
      checkin: "2026-10-01",
      checkout: "2026-10-03",
      nights: 2,
      rooms: [],
      total: 120,
      currency: "EUR",
      guest: { firstName: "A", lastName: "B", email: "a@example.com", phone: "" },
      payment: { provider: "viva", mode: "payment", accountId: "m", sessionId: "o", transactionId: "tx_1", amount: 120, currency: "EUR" },
    } as never;
    expect((await claimBooking(PID, draft)).won).toBe(true);
    const booking = (await getBooking(PID, "b-refund"))!;

    vivaCalls.length = 0;
    const outcomes = await Promise.all([
      refundBookingCharge(PID, booking, { by: "guest" }),
      refundBookingCharge(PID, booking, { by: "guest-dup" }),
      refundBookingCharge(PID, booking, { by: "admin" }),
    ]);
    expect(vivaCalls).toHaveLength(1);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.reason === "already_refunded")).toHaveLength(2);
    // Recorded on the booking; a later call with the fresh record is a no-op too.
    const after = (await getBooking(PID, "b-refund"))!;
    expect(after.payment?.refund?.id).toBe("rf_1");
    expect(await refundBookingCharge(PID, after)).toMatchObject({ ok: false, reason: "already_refunded" });
    expect(vivaCalls).toHaveLength(1);
  });
});
