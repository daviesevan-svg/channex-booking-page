import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// The post-booking redirect must be a DOCUMENT navigation.
//
// A guest lost a seven-room Christmas booking to this on 2026-09-02: the action
// ran clean (the Worker logged a 202), the booking was created and the
// confirmation email sent, and then the browser never requested the
// confirmation page at all. A client-side redirect has to discover the
// confirmation route first, and in a tab opened before the last deploy that
// discovery fetches /__manifest with a stale version — which the server answers
// 204 + X-Remix-Reload-Document. React Router gives up on that once per stale
// version and the navigation dies on the root error boundary.
//
// So this asserts the RESPONSE the action returns, over a real SQLite behind
// the D1 shim (same pattern as manage-reads.test.ts): a document redirect
// carries X-Remix-Reload-Document, a client-side one does not, and that header
// is the whole difference between the guest seeing their booking and seeing
// "Oops!".

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
  list: async () => ({ keys: [], list_complete: true }),
};

const sqlite = new DatabaseSync(":memory:");
type Stmt = { sql: string; args: unknown[]; bind: (...a: unknown[]) => Stmt; all: () => Promise<unknown>; first: () => Promise<unknown>; run: () => Promise<unknown> };
const exec = (s: Stmt) => {
  const p = sqlite.prepare(s.sql);
  if (/^\s*(select|with)/i.test(s.sql)) return { results: p.all(...(s.args as never[])) };
  const info = p.run(...(s.args as never[]));
  return { results: [], meta: { changes: Number(info.changes ?? 0) } };
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
  env: {
    CONFIG_KV: kv,
    DB: fakeD1,
    APP_URL: "http://localhost",
    SESSION_SECRET: "test-secret-not-the-placeholder",
  },
  waitUntil: () => {},
}));

const PID = "p1";
const SLUG = "casa-test";
const ROOM = "room1";
const RATE = "rate1";
// Far enough out that no booking cutoff or last-minute rule declines the stay.
const CHECKIN = "2027-05-10";
const CHECKOUT = "2027-05-12";

function seed() {
  store.set("properties", JSON.stringify([{ id: PID, name: "Casa Test", slug: SLUG, public: true }]));
  // No connectedSystem: the booking simulates instead of pushing to Channex, and
  // no gateway is configured — the pay-at-property path this bug lives on.
  store.set(
    "settings:" + PID,
    JSON.stringify({ currency: "EUR", languages: ["en"], checkinTime: "14:00", taxesInclusive: true }),
  );
  store.set("overrides:" + PID, JSON.stringify({ en: { hotelName: "Casa Test" } }));
  store.set(
    "catalog_rooms:" + PID,
    JSON.stringify([
      { id: ROOM, title: "Double", images: [], maxAdults: 2, maxGuests: 2, facilities: [], position: 0, createdAt: "2026-01-01" },
    ]),
  );
  store.set(
    "catalog_rates:" + PID,
    JSON.stringify([
      { id: RATE, title: "Standard", prices: { [ROOM]: 12000 }, refundable: true, inclusions: [], active: true, createdAt: "2026-01-01" },
    ]),
  );

  // Inventory for both nights, so the cart resolves and the pre-commit
  // availability check passes.
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS availability (hotel_code TEXT NOT NULL, room_type_id TEXT NOT NULL, date TEXT NOT NULL, avail INTEGER NOT NULL, PRIMARY KEY (hotel_code, room_type_id, date))`,
  );
  for (const date of [CHECKIN, "2027-05-11"]) {
    sqlite.prepare(`INSERT OR REPLACE INTO availability VALUES (?,?,?,?)`).run(PID, ROOM, date, 3);
  }
}

const query = `checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=2&sel=${ROOM}%3A${RATE}%3A2`;

function bookingRequest() {
  const body = new URLSearchParams({
    intent: "book",
    firstName: "Jamie",
    lastName: "Doyle",
    email: "jamie@example.com",
    phone: "+351 900 000 000",
    consent: "on",
  });
  return new Request(`http://localhost/${SLUG}/checkout?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

async function book() {
  const { action } = await import("~/routes/property/checkout");
  try {
    const result = await action({
      request: bookingRequest(),
      params: { channelId: SLUG },
      context: {},
    } as never);
    return result as Response;
  } catch (thrown) {
    // React Router redirects are thrown from some paths and returned from
    // others; either way the Response is what we assert on.
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

describe("the redirect that lands a guest on their confirmation", () => {
  it("is a document navigation, so it cannot depend on the tab's build being current", async () => {
    seed();

    const res = await book();

    // Landed on the confirmation page for a real, created booking...
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain(`/${SLUG}/confirmation/`);
    // ...and told the browser to fetch it as a document. Without this header
    // React Router follows the redirect client-side, which needs route
    // discovery, which is exactly what fails in a tab that has been deployed
    // over.
    expect(res.headers.get("X-Remix-Reload-Document")).toBe("true");

    // The booking really was created — the redirect above is the one a paying
    // guest gets, not an early bail-out that happens to look like it.
    const { getBookings } = await import("./bookings.server");
    const bookings = await getBookings(PID);
    expect(bookings).toHaveLength(1);
    expect(bookings[0].reference).toBe(location.split("/confirmation/")[1]?.split("?")[0]);
  });

  it("stays a document navigation when the same stay is submitted twice", async () => {
    // The replay path returns the first submit's confirmation URL. A guest who
    // double-submits, or whose tab retries, must not be routed through the
    // client-side redirect the first submit deliberately avoided.
    const first = await book();
    const second = await book();

    expect(second.status).toBe(302);
    expect(second.headers.get("Location")).toBe(first.headers.get("Location"));
    expect(second.headers.get("X-Remix-Reload-Document")).toBe("true");

    // And still exactly one booking for the stay.
    const { getBookings } = await import("./bookings.server");
    expect(await getBookings(PID)).toHaveLength(1);
  });
});
