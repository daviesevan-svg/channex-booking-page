import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Google feed builders read several KV/D1 records per property. They used
// to do it one property at a time, so the feed took ~4 s warm and ~40 s cold at
// ~100 properties. Pins: the same listings in the same order as before, the
// same readiness filtering, and wall time bounded by the concurrency, not the
// property count. Storage is faked with a fixed latency per read.

const LATENCY_MS = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Fixture = {
  id: string;
  public: boolean;
  settings: Record<string, unknown>;
  overrides: Record<string, string>;
  ari?: boolean;
  rooms?: unknown[];
};
let fixtures: Fixture[] = [];
let inFlight = 0;
let maxInFlight = 0;
async function read<T>(value: T): Promise<T> {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await sleep(LATENCY_MS);
  inFlight--;
  return value;
}
const byId = (id: string) => fixtures.find((f) => f.id === id)!;

vi.mock("./config.server", () => ({ getConfig: () => ({ appUrl: "https://book.example.test" }) }));
vi.mock("./properties.server", () => ({
  getProperties: async () => read(fixtures.map((f) => ({ id: f.id, name: `Registry ${f.id}`, public: f.public }))),
}));
vi.mock("./overrides.server", () => ({
  getSettings: async (pid: string) => read(byId(pid).settings),
  getOverrides: async (pid: string) => read(byId(pid).overrides),
  getVivaConfig: async () => read(null),
}));
vi.mock("./ari/ingest.server", () => ({ hasReceivedAri: async (pid: string) => read(Boolean(byId(pid).ari)) }));
vi.mock("./catalog.server", () => ({ getRooms: async (pid: string) => read(byId(pid).rooms ?? []) }));

const { googleListingElements, FEED_CONCURRENCY } = await import("./hotel-list-feed.server");
const { vrListingElements } = await import("./vr-list-feed.server");

const ready = (i: number, extra: Record<string, unknown> = {}): Fixture => ({
  id: `p${String(i).padStart(3, "0")}`,
  public: true,
  settings: {
    addressCity: "Noida",
    addressCountry: "IN",
    latitude: "28.5",
    longitude: "77.3",
    connectedSystem: "channex",
    ...extra,
  },
  overrides: { hotelName: `Hotel ${i}`, address: `${i} Main St` },
  ari: true,
});

const ids = (xml: string) => [...xml.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);

beforeEach(() => {
  inFlight = 0;
  maxInFlight = 0;
});

describe("googleListingElements", () => {
  it("lists every ready public property, in registry order, and skips the rest", async () => {
    fixtures = [
      ready(1),
      { ...ready(2), public: false },
      ready(3),
      { ...ready(4), overrides: { address: "no name" } },
      { ...ready(5), ari: false },
      { ...ready(6), settings: { ...ready(6).settings, stripeAccountId: "acct_1", stripeChargesEnabled: true, connectedSystem: undefined } },
      ready(7),
    ];
    const xml = await googleListingElements();
    expect(ids(xml)).toEqual(["p001", "p003", "p006", "p007"]);
    expect(xml).toContain("<name>Hotel 3</name>");
    expect(xml.split("<listing>")).toHaveLength(5);
  });

  it("takes about (properties / concurrency) round trips, not one per property", async () => {
    fixtures = Array.from({ length: 100 }, (_, i) => ready(i + 1));
    const t0 = performance.now();
    const xml = await googleListingElements();
    const ms = performance.now() - t0;
    expect(ids(xml)).toHaveLength(100);
    expect(ids(xml)[0]).toBe("p001");
    expect(ids(xml)[99]).toBe("p100");
    // 100 properties × 2 sequential reads × 20 ms was ~4 s one at a time.
    expect(ms).toBeLessThan(1500);
    expect(maxInFlight).toBeLessThanOrEqual(FEED_CONCURRENCY * 2);
  });
});

describe("vrListingElements", () => {
  it("lists ready public vacation rentals with a unit, in order", async () => {
    const unit = { maxGuests: 4, images: [], description: "Flat", amenities: [] };
    const vr = (i: number) => ({ ...ready(i, { googleProgram: "vacation_rentals" }), rooms: [unit] });
    fixtures = [vr(1), ready(2), vr(3), { ...vr(4), rooms: [] }, { ...vr(5), public: false }, { ...vr(6), ari: false }, vr(7)];
    const xml = await vrListingElements();
    expect(ids(xml)).toEqual(["p001", "p003", "p007"]);
    expect(xml).toContain('<client_attr name="capacity">4</client_attr>');
  });

  it("is concurrent too", async () => {
    const unit = { maxGuests: 2, images: [], description: "", amenities: [] };
    fixtures = Array.from({ length: 100 }, (_, i) => ({ ...ready(i + 1, { googleProgram: "vacation_rentals" }), rooms: [unit] }));
    const t0 = performance.now();
    expect(ids(await vrListingElements())).toHaveLength(100);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("hasReceivedAri's single query", () => {
  // The SQL itself, against real SQLite: ?1 is reused for both lookups.
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE availability (hotel_code TEXT, date TEXT); CREATE TABLE rate (hotel_code TEXT, date TEXT);`);
  sqlite.exec(`INSERT INTO availability VALUES ('a', '2026-10-01'); INSERT INTO rate VALUES ('r', '2026-10-01');`);
  const q = sqlite.prepare(
    `SELECT EXISTS(SELECT 1 FROM availability WHERE hotel_code=?1)
         OR EXISTS(SELECT 1 FROM rate WHERE hotel_code=?1) AS x`,
  );
  it.each([
    ["a", 1],
    ["r", 1],
    ["none", 0],
  ])("hotel %s → %d", (code, want) => {
    expect((q.get(code) as { x: number }).x).toBe(want);
  });
});
