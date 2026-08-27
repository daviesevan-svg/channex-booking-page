import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// End-to-end reads for the management API: real route loaders, real server
// libs, real key auth — over an in-memory KV and a real SQLite behind a
// minimal D1 shim (same pattern as ingest-roundtrip.test.ts). What this pins:
// scope enforcement at each endpoint, the serializers' no-secrets rule, and
// that the ARI read returns major units decoded per fraction_size.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

const sqlite = new DatabaseSync(":memory:");
type Stmt = { sql: string; args: unknown[]; bind: (...a: unknown[]) => Stmt; all: () => Promise<unknown>; first: () => Promise<unknown>; run: () => Promise<unknown> };
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
  env: { CONFIG_KV: kv, DB: fakeD1 },
  waitUntil: () => {},
}));

const req = (path: string, key: string) =>
  new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${key}` } });

async function seed() {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa Test", slug: "casa-test", public: true }]));
  store.set("settings:p1", JSON.stringify({ currency: "VND", languages: ["en", "de"], checkinTime: "14:00", taxesInclusive: true, taxes: [{ id: "t1", name: "VAT", rate: 10 }], connectedSystem: "channex" }));
  store.set("overrides:p1", JSON.stringify({ en: { hotelName: "Casa Test", description: "A test hotel." }, de: { description: "Ein Testhotel." } }));
  store.set(
    "catalog_rooms:p1",
    JSON.stringify([{ id: "room1", title: "Double", images: [], maxAdults: 2, maxGuests: 2, facilities: [], position: 0, createdAt: "2026-01-01", translations: { de: { title: "Doppelzimmer" } } }]),
  );
  store.set(
    "catalog_rates:p1",
    JSON.stringify([{ id: "rate1", title: "BAR", prices: { room1: 500000 }, refundable: true, inclusions: [], active: true, createdAt: "2026-01-01", channexRateIds: { room1: "cxr1" } }]),
  );
  store.set("extras:p1", JSON.stringify([{ id: "x1", name: "Breakfast", unit: "per_person_night", price: 90000, active: true, position: 0, createdAt: "2026-01-01" }]));
  store.set("promotions:p1", JSON.stringify([{ id: "pr1", trigger: "code", code: "SAVE10", type: "percent", value: 10, enabled: true, createdAt: "2026-01-01" }]));
}

async function seedAriAndBooking() {
  const { applyChanges } = await import("./ari/ingest.server");
  await applyChanges({
    data: [
      {
        type: "changes_notification",
        attributes: {
          hotel_code: "p1",
          changes: [
            {
              type: "availability_changes",
              attributes: { room_type_id: "room1", rate_plan_id: "cxr1", date_from: "2026-10-01", date_to: "2026-10-02", availability: 3 },
            },
            {
              type: "restriction_changes",
              attributes: {
                room_type_id: "room1",
                rate_plan_id: "cxr1",
                date_from: "2026-10-01",
                date_to: "2026-10-02",
                rates: [{ currency: "VND", occupancy: 2, rate: "500000", fraction_size: 0 }],
                min_stay: 2,
              },
            },
          ],
        },
      },
    ],
  });
  const { getBookings } = await import("./bookings.server");
  await getBookings("p1"); // creates the booking table
  const booking = {
    id: "b1",
    reference: "OSA-TEST1",
    status: "confirmed",
    createdAt: "2026-08-01T10:00:00Z",
    currency: "VND",
    checkin: "2026-10-01",
    checkout: "2026-10-03",
    nights: 2,
    total: 1_000_000,
    guest: { firstName: "An", lastName: "Nguyen", email: "an@example.com", phone: "+84" },
    rooms: [{ roomId: "room1", roomTitle: "Double", rateId: "rate1", rateTitle: "BAR", adults: 2, children: 0, total: 1_000_000 }],
    payment: { provider: "stripe", mode: "payment", accountId: "acct_SECRET", sessionId: "cs_SECRET", paymentIntentId: "pi_SECRET", amount: 1_000_000, currency: "VND", cardLast4: "4242", cardBrand: "visa" },
  };
  sqlite
    .prepare(`INSERT INTO booking (pid,id,reference,email,created_at,lifecycle,json) VALUES (?,?,?,?,?,?,?)`)
    .run("p1", "b1", "OSA-TEST1", "an@example.com", booking.createdAt, "active", JSON.stringify(booking));
}

describe("management API reads", () => {
  it("serves the phase-A read surface to an ak_ key and refuses sk_ keys", async () => {
    await seed();
    await seedAriAndBooking();
    const { issueApiKey } = await import("./api-auth.server");
    const { raw: ak } = await issueApiKey("p1", { label: "m", mode: "live", scope: "manage" });
    const { raw: sk } = await issueApiKey("p1", { label: "b", mode: "live" });

    const property = await (await import("../routes/api.v1.manage.property")).loader({ request: req("/v1/manage/property", ak) } as never);
    const propertyJson = (await (property as Response).json()) as { data: Record<string, unknown> };
    expect(propertyJson.data).toMatchObject({ id: "p1", name: "Casa Test", slug: "casa-test", currency: "VND", connected_system: "channex" });

    const refused = await (await import("../routes/api.v1.manage.property")).loader({ request: req("/v1/manage/property", sk) } as never);
    expect((refused as Response).status).toBe(403);

    const content = await (await import("../routes/api.v1.manage.property.content")).loader({ request: req("/v1/manage/property/content?lang=de", ak) } as never);
    const contentJson = (await (content as Response).json()) as { data: { values: Record<string, string>; effective: Record<string, string> } };
    expect(contentJson.data.values.description).toBe("Ein Testhotel.");
    expect(contentJson.data.values.hotelName).toBeUndefined(); // stored German has no name…
    expect(contentJson.data.effective.hotelName).toBe("Casa Test"); // …but the effective view falls back

    const rooms = await (await import("../routes/api.v1.manage.rooms")).loader({ request: req("/v1/manage/rooms", ak) } as never);
    const roomsJson = (await (rooms as Response).json()) as { data: { id: string; translations: Record<string, unknown> }[] };
    expect(roomsJson.data[0].id).toBe("room1");
    expect(roomsJson.data[0].translations.de).toEqual({ title: "Doppelzimmer" });

    const rates = await (await import("../routes/api.v1.manage.rates")).loader({ request: req("/v1/manage/rates", ak) } as never);
    const ratesJson = (await (rates as Response).json()) as { data: { prices: Record<string, number>; channex_rate_ids: Record<string, string> }[] };
    expect(ratesJson.data[0].prices).toEqual({ room1: 500000 });
    expect(ratesJson.data[0].channex_rate_ids).toEqual({ room1: "cxr1" });

    const taxes = await (await import("../routes/api.v1.manage.taxes")).loader({ request: req("/v1/manage/taxes", ak) } as never);
    expect(((await (taxes as Response).json()) as { data: { taxes_inclusive: boolean } }).data.taxes_inclusive).toBe(true);

    const extras = await (await import("../routes/api.v1.manage.extras")).loader({ request: req("/v1/manage/extras", ak) } as never);
    expect(((await (extras as Response).json()) as { data: unknown[] }).data).toHaveLength(1);
    expect(store.has("extras_seeded:p1")).toBe(false); // API list must not demo-seed

    const promos = await (await import("../routes/api.v1.manage.promotions")).loader({ request: req("/v1/manage/promotions", ak) } as never);
    expect(((await (promos as Response).json()) as { data: { code: string }[] }).data[0].code).toBe("SAVE10");
  });

  it("lists bookings without gateway internals and finds one by reference", async () => {
    const { issueApiKey } = await import("./api-auth.server");
    const { raw: ak } = await issueApiKey("p1", { label: "m2", mode: "live", scope: "manage" });

    const list = await (await import("../routes/api.v1.manage.bookings")).loader({ request: req("/v1/manage/bookings?status=confirmed", ak) } as never);
    const listJson = (await (list as Response).json()) as { total: number; data: { reference: string; payment: Record<string, unknown> }[] };
    expect(listJson.total).toBe(1);
    expect(listJson.data[0].reference).toBe("OSA-TEST1");
    const payment = listJson.data[0].payment;
    expect(payment).toMatchObject({ provider: "stripe", amount: 1_000_000, card_last4: "4242" });
    // The no-secrets rule: none of the gateway ids may appear anywhere.
    expect(JSON.stringify(listJson)).not.toMatch(/acct_SECRET|cs_SECRET|pi_SECRET/);

    const one = await (await import("../routes/api.v1.manage.bookings.$id")).loader({
      request: req("/v1/manage/bookings/OSA-TEST1", ak),
      params: { id: "OSA-TEST1" },
    } as never);
    expect(((await (one as Response).json()) as { data: { id: string } }).data.id).toBe("b1");

    const missing = await (await import("../routes/api.v1.manage.bookings.$id")).loader({
      request: req("/v1/manage/bookings/nope", ak),
      params: { id: "nope" },
    } as never);
    expect((missing as Response).status).toBe(404);
  });

  it("returns the ARI grid in major units (VND stays whole) and validates the window", async () => {
    const { issueApiKey } = await import("./api-auth.server");
    const { raw: ak } = await issueApiKey("p1", { label: "m3", mode: "live", scope: "manage" });
    const { loader } = await import("../routes/api.v1.manage.ari");

    const res = await loader({ request: req("/v1/manage/ari?from=2026-10-01&to=2026-10-02", ak) } as never);
    const json = (await (res as Response).json()) as {
      data: {
        availability: { date: string; available: number }[];
        rates: { date: string; price: number; prices_by_occupancy: Record<string, number> }[];
        restrictions: { date: string; min_stay: number }[];
      };
    };
    expect(json.data.availability).toHaveLength(2);
    expect(json.data.availability[0]).toMatchObject({ date: "2026-10-01", available: 3 });
    expect(json.data.rates[0]).toMatchObject({ date: "2026-10-01", price: 500_000 });
    expect(json.data.rates[0].prices_by_occupancy).toEqual({ 2: 500_000 });
    expect(json.data.restrictions[0].min_stay).toBe(2);

    const tooWide = await loader({ request: req("/v1/manage/ari?from=2026-01-01&to=2027-06-01", ak) } as never);
    expect((tooWide as Response).status).toBe(422);
    const badDate = await loader({ request: req("/v1/manage/ari?from=notadate&to=2026-10-02", ak) } as never);
    expect((badDate as Response).status).toBe(422);
  });

  it("filters the MCP tool list by key scope", async () => {
    const { publicToolList } = await import("./mcp");
    const bookNames = publicToolList("book").map((t) => t.name);
    const manageNames = publicToolList("manage").map((t) => t.name);
    expect(bookNames).toContain("search_availability");
    expect(bookNames).not.toContain("get_ari");
    expect(manageNames).toContain("get_ari");
    expect(manageNames).toContain("list_bookings");
    expect(manageNames).not.toContain("create_booking");
    // Names must be globally unique — toolByName resolves across both sets.
    const all = [...bookNames, ...manageNames];
    expect(new Set(all).size).toBe(all.length);
  });
});
