import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What happens to a Channex ARI push when D1 misbehaves — driven through the
// REAL /api/changes action so the recovery and the status code are exercised
// together, over a real SQLite behind a D1 shim (same pattern as
// ingest-roundtrip.test.ts).
//
// This pins the failure that caused a live overbooking: an availability: 0 +
// stop_sell push for 2026-10-03 hit "this D1 DB instance is no longer active",
// was answered 422 (permanent — don't re-send), never retried and never
// recovered, so the room stayed on sale. Assertions are on the stored ROWS and
// the response status, not on whether the code appears to attempt a retry.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

const sqlite = new DatabaseSync(":memory:");
type Stmt = { sql: string; args: unknown[]; bind: (...a: unknown[]) => Stmt; first: () => Promise<unknown> };
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
  first: async function () {
    const r = exec(this as unknown as Stmt) as { results: unknown[] };
    return r.results[0] ?? null;
  },
});

/** Errors the shim throws instead of running a batch, oldest first. Each batch
 *  call shifts one off, so [err] fails the first attempt only. */
let batchFailures: Error[] = [];
let batchCalls = 0;
const fakeD1 = {
  prepare: (sql: string) => makeStmt(sql),
  batch: async (stmts: Stmt[]) => {
    batchCalls++;
    const failure = batchFailures.shift();
    if (failure) throw failure;
    return stmts.map(exec);
  },
};

/** The verbatim production error — the point is that this exact string is
 *  recognised as retryable, so it is not paraphrased here. */
const d1Recycled = () =>
  new Error(
    "D1_ERROR: Connection closed: this D1 DB instance is no longer active. Reconnect or retry the request.",
  );

const pending: Promise<unknown>[] = [];
vi.mock("cloudflare:workers", () => ({
  env: {
    CONFIG_KV: kv,
    DB: fakeD1,
    OPEN_CHANNEL_API_KEY: "test-key",
    PROVIDER_CODE: "RoomPanda",
    OPEN_CHANNEL_BOOKING_URL: "https://app.channex.io/api/v1/channel_webhooks/roompanda/new_booking",
  },
  waitUntil: (p: Promise<unknown>) => void pending.push(p),
}));

/** Settle the fire-and-forget work the action queued (full-sync request, Google
 *  forward) — waitUntil would in production. */
async function drain() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
}

const ROOM = "28831b41-efd4-4b2f-af4c-fd76a4e28c91";
const PLAN = "5b201a44-002d-46fa-8e83-fcb77e4dc05a";

/** The push from the incident: close 2026-10-03 outright. */
const closeOctober3 = (hotel: string) => ({
  data: [
    {
      type: "changes_notification",
      attributes: {
        request_id: "04671f9c-b4a3-4a6e-807e-5f9ba4dfdceb",
        hotel_code: hotel,
        changes: [
          {
            type: "restriction_changes",
            attributes: { rate_plan_id: PLAN, room_type_id: ROOM, date_from: "2026-10-03", date_to: "2026-10-03", stop_sell: true },
          },
          {
            type: "availability_changes",
            attributes: { room_type_id: ROOM, date_from: "2026-10-03", date_to: "2026-10-03", availability: 0 },
          },
        ],
      },
    },
  ],
});

const post = (body: unknown) =>
  new Request("http://localhost/api/changes", {
    method: "POST",
    headers: { "api-key": "test-key", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function callChanges(body: unknown) {
  const { action } = await import("~/routes/api.changes");
  return (await action({ request: post(body), params: {}, context: {} } as never)) as Response;
}

/** A hotel connected to Channex, so the batch isn't rejected up front. */
function connect(hotel: string) {
  store.set("settings:" + hotel, JSON.stringify({ connectedSystem: "channex" }));
}

const availOn = (hotel: string, date: string) =>
  sqlite.prepare("SELECT avail FROM availability WHERE hotel_code=? AND room_type_id=? AND date=?").get(hotel, ROOM, date) as
    | { avail: number }
    | undefined;

const stopSellOn = (hotel: string, date: string) =>
  sqlite
    .prepare("SELECT stop_sell FROM restriction WHERE hotel_code=? AND room_type_id=? AND rate_plan_id=? AND date=?")
    .get(hotel, ROOM, PLAN, date) as { stop_sell: number } | undefined;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  batchFailures = [];
  batchCalls = 0;
  pending.length = 0;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("Channex ARI ingest when D1 fails", () => {
  it("still stores a stop-sell whose write hits a recycled D1 instance", async () => {
    const hotel = "hotel-transient";
    connect(hotel);
    // Fail the schema batch and then the write batch once each, exactly as a
    // mid-request instance recycle would.
    batchFailures = [d1Recycled(), d1Recycled()];

    const res = await callChanges(closeOctober3(hotel));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, availability: 1, restrictions: 1 });
    // The whole point: the room is closed in our store afterwards.
    expect(availOn(hotel, "2026-10-03")).toEqual({ avail: 0 });
    expect(stopSellOn(hotel, "2026-10-03")).toEqual({ stop_sell: 1 });
  });

  it("answers 503 and asks Channex for a full re-send when D1 stays down", async () => {
    const hotel = "hotel-down";
    connect(hotel);
    batchFailures = Array.from({ length: 20 }, d1Recycled);

    const res = await callChanges(closeOctober3(hotel));
    await drain();

    // 503, not 422: the message was fine, our storage was not.
    expect(res.status).toBe(503);
    // Retried rather than given up on after one go.
    expect(batchCalls).toBeGreaterThan(1);
    // And the lost change is recovered by asking for the property in full.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://app.channex.io/api/v1/channel_webhooks/roompanda/request_full_sync");
    expect(JSON.parse(String(init.body))).toEqual({ provider_code: "RoomPanda", hotel_code: hotel });
  });

  it("requests a full sync at most once per property while it keeps failing", async () => {
    const hotel = "hotel-storm";
    connect(hotel);
    batchFailures = Array.from({ length: 40 }, d1Recycled);

    for (let i = 0; i < 3; i++) {
      await callChanges(closeOctober3(hotel));
      await drain();
    }

    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/request_full_sync"))).toHaveLength(1);
  });

  it("keeps 422 for a payload we genuinely cannot process", async () => {
    const res = await callChanges({ notData: true });
    await drain();

    expect(res.status).toBe(422);
    // Nothing to recover: a body we can't parse names no property, so there is
    // no full sync to ask for.
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it("does not retry a statement D1 rejected, and answers 422", async () => {
    const hotel = "hotel-rejected";
    connect(hotel);
    // A successful push first, so the per-isolate schema latch is set and the
    // batch counted below is unambiguously the write.
    await callChanges(closeOctober3(hotel));
    await drain();
    batchCalls = 0;
    batchFailures = Array.from({ length: 5 }, () => new Error("D1_ERROR: no such table: availability"));

    const res = await callChanges(closeOctober3(hotel));

    expect(res.status).toBe(422);
    // Two D1 operations run before the throw escapes — the pre-change snapshot
    // and the write — and each is attempted exactly once. Retrying a rejected
    // statement would only repeat the failure, and would consume three
    // failures apiece.
    expect(batchCalls).toBe(2);
  });
});

describe("isTransientD1Error", () => {
  it("separates instance recycles from rejected statements", async () => {
    const { isTransientD1Error } = await import("../d1.server");

    expect(isTransientD1Error(d1Recycled())).toBe(true);
    expect(isTransientD1Error(new Error("Network connection lost."))).toBe(true);
    // Retrying these would only repeat the same failure.
    expect(isTransientD1Error(new Error("D1_ERROR: UNIQUE constraint failed: booking.booking_ref"))).toBe(false);
    expect(isTransientD1Error(new Error("D1_ERROR: no such table: availability"))).toBe(false);
    expect(isTransientD1Error(new Error("D1_ERROR: too many SQL variables"))).toBe(false);
  });
});
