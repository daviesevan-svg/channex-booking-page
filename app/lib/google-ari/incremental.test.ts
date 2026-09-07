import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1 } from "../test-d1";
import { buildRateAmountXml } from "./xml";
import { boundAriScope, mergeAriScopes } from "./scope";
const { sqlite, d1 } = makeTestD1();
const rooms = [{ id: "room", maxAdults: 2, maxGuests: 2 }, { id: "other", maxAdults: 2, maxGuests: 2 }];
const rates = [{ id: "local", channexRateIds: { room: "remote" }, active: true, prices: { room: 100, other: 150 } }];
vi.mock("cloudflare:workers", () => ({ env: { DB: d1, CONFIG_KV: { get: async () => null, put: async () => {} } }, waitUntil: () => {} }));
vi.mock("../catalog.server", () => ({ getRooms: async () => rooms, getRates: async () => rates, pricingModeOf: () => "per_person", rateChannexId: (_rate: unknown, roomId: string) => roomId === "room" ? "remote" : "other-rate" }));
vi.mock("../overrides.server", () => ({ getSettings: async () => ({ currency: "GBP" }) }));

beforeEach(async () => {
  const { ensureSchema } = await import("../ari/schema.server");
  await ensureSchema();
  for (const table of ["availability", "rate", "restriction", "ari_log"]) sqlite.exec(`DELETE FROM ${table}`);
  for (const date of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
    for (const room of ["room", "other"]) sqlite.prepare("INSERT INTO availability VALUES (?, ?, ?, ?)").run("hotel", room, date, 5);
    for (const occ of [1, 2]) sqlite.prepare("INSERT INTO rate VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("hotel", "room", "remote", date, occ, occ * 9000, "GBP", 2);
  }
});

describe("incremental Google ARI payloads", () => {
  it("reads only inventory for an availability change and preserves holes between dates", async () => {
    const { collectAri } = await import("./rates.server");
    const payload = await collectAri("hotel", { from: "2026-10-01", to: "2026-10-03" }, {
      availability: [{ roomId: "room", dates: ["2026-10-01", "2026-10-03"] }], products: [],
    });
    expect(payload.rates).toEqual([]);
    expect(payload.avail).toEqual([]);
    expect(payload.inventory).toEqual([
      { roomId: "room", start: "2026-10-01", end: "2026-10-01", count: 5 },
      { roomId: "room", start: "2026-10-03", end: "2026-10-03", count: 5 },
    ]);
  });

  it("sends the complete occupancy overlay for only the changed remote product and dates", async () => {
    const { collectAri } = await import("./rates.server");
    const payload = await collectAri("hotel", { from: "2026-10-01", to: "2026-10-03" }, {
      availability: [], products: [{ roomId: "room", rateId: "remote", dates: ["2026-10-01", "2026-10-03"] }],
    });
    expect(payload.inventory).toEqual([]);
    expect(payload.rates).toHaveLength(2);
    expect(payload.avail).toHaveLength(2);
    for (const entry of payload.rates) {
      expect(entry.roomId).toBe("room");
      expect(entry.rateId).toBe("remote");
      expect(entry.start).toBe(entry.end);
      expect(entry.amounts).toEqual([{ guests: 1, net: 90, gross: 90 }, { guests: 2, net: 180, gross: 180 }]);
    }
    const xml = buildRateAmountXml({ partner: "partner", hotelId: "hotel", id: "test", timestamp: "2026-10-01T00:00:00Z" }, payload.rates);
    expect(xml).toContain('NotifType="Overlay" NotifScopeType="ProductRate"');
    expect(xml).not.toContain("2026-10-02");
  });

  it("preserves a scoped stop-sell and omits dates outside the configured window", async () => {
    sqlite.prepare("INSERT INTO restriction (hotel_code,room_type_id,rate_plan_id,date,stop_sell) VALUES (?, ?, ?, ?, 1)").run("hotel", "room", "remote", "2026-10-01");
    const { collectAri } = await import("./rates.server");
    const payload = await collectAri("hotel", { from: "2026-10-01", to: "2026-10-03" }, {
      availability: [], products: [{ roomId: "room", rateId: "remote", dates: ["2026-09-30", "2026-10-01", "2027-01-01"] }],
    });
    expect(payload.avail).toEqual([{ roomId: "room", rateId: "local", start: "2026-10-01", end: "2026-10-01", stopSell: true, cta: false, ctd: false, minStay: 1 }]);
    expect(payload.rates).toHaveLength(1);
  });

  it("the ingest returns deduplicated Google scopes, stop-sell-only changes included, and bounds their size", async () => {
    const { applyChanges } = await import("../ari/ingest.server");
    const changes = ["2026-10-03", "2026-10-01"].map((date) => ({ type: "restriction_changes", attributes: { room_type_id: "room", rate_plan_id: "remote", date_from: date, date_to: date, stop_sell: true } }));
    const { scopes } = await applyChanges({ data: [
      { attributes: { hotel_code: "hotel", changes: [...changes, changes[0]] } },
      // Nothing applied for this hotel: it must not appear (no enqueue, no repair marker).
      { attributes: { hotel_code: "idle", changes: [{ type: "something_else", attributes: {} }] } },
    ] });
    expect([...scopes.keys()]).toEqual(["hotel"]);
    // A stop-sell moves what Google may sell even though it is not audited.
    expect(scopes.get("hotel")).toEqual({ availability: [], products: [{ roomId: "room", rateId: "remote", dates: ["2026-10-01", "2026-10-03"] }] });
    const huge = { availability: Array.from({ length: 2000 }, (_, i) => ({ roomId: `room-${i}`, dates: ["2026-10-01", "2026-10-03"] })), products: [] };
    expect(boundAriScope(huge)).toBeUndefined();
    expect(mergeAriScopes(huge, huge)).toBeUndefined();
    expect(mergeAriScopes(scopes.get("hotel"), undefined)).toBeUndefined();
  });
});
