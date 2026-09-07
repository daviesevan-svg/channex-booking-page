import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AriPayload } from "./rates.server";
const mocks = vi.hoisted(() => ({ collect: vi.fn(), submit: vi.fn() }));
vi.mock("../config.server", () => ({ getConfig: () => ({ googleAriPartnerKey: "partner", googleAriBaseUrl: "https://google.example" }) }));
vi.mock("../catalog.server", () => ({ getRooms: async () => [], getRates: async () => [], rateChannexId: () => "rate" }));
vi.mock("../google-readiness.server", () => ({ checkGoogleReadiness: async () => ({ ready: true }) }));
vi.mock("../overrides.server", () => ({ getSettings: async () => ({ googleAriPush: true }), recordGoogleAriSync: async () => {} }));
vi.mock("../properties.server", () => ({ getProperties: async () => [{ id: "hotel" }] }));
vi.mock("./rates.server", () => ({ ariWindow: () => ({ from: "2026-10-01", to: "2026-10-03" }), collectAri: mocks.collect, googleTaxLines: () => ({ taxes: [], fees: [] }) }));
vi.mock("./promotions.server", () => ({ googlePromotions: async () => [] }));
vi.mock("./status.server", () => ({ gateMatchStatus: async () => ({ state: "matched" }) }));
vi.mock("./queue-client.server", () => ({ submitGoogleAriWork: mocks.submit }));
import { scheduledGoogleAriSync, syncAri } from "./push.server";
let transport: ReturnType<typeof vi.fn>;
const date = { start: "2026-10-01", end: "2026-10-01" };
const payload: AriPayload = {
  rates: [{ ...date, roomId: "open", rateId: "rate", currency: "GBP", amounts: [{ guests: 1, net: 100, gross: 100 }] }],
  avail: [
    { ...date, roomId: "closed", rateId: "rate", stopSell: true, cta: false, ctd: false, minStay: 1 },
    { ...date, roomId: "open", rateId: "rate", stopSell: false, cta: false, ctd: false, minStay: 1 },
  ],
  inventory: [{ ...date, roomId: "closed", count: 0 }, { ...date, roomId: "open", count: 5 }],
};
beforeEach(() => {
  mocks.collect.mockReset().mockResolvedValue(payload);
  mocks.submit.mockReset().mockResolvedValue([]);
  transport = vi.fn(async () => new Response("<Success/>"));
  vi.stubGlobal("fetch", transport);
});

describe("Google delivery order", () => {
  it("sends closeouts immediately and prices before reopening or increasing counts", async () => {
    await syncAri("hotel");
    const bodies = transport.mock.calls.map((call) => String((call[1] as RequestInit).body));
    expect(bodies).toHaveLength(5);
    expect(bodies[0]).toContain('Status="Close"');
    expect(bodies[1]).toContain('Count="0"');
    expect(bodies[2]).toContain("OTA_HotelRateAmountNotifRQ");
    expect(bodies[3]).toContain('Status="Open"');
    expect(bodies[4]).toContain('Count="5"');
  });

  it("retains the failure and does not reopen when Google rejects prices", async () => {
    transport.mockImplementation(async (url: string) => new Response(url.endsWith("hotel_rate_amount_notif") ? "<Errors><Error/></Errors>" : "<Success/>"));
    const results = await syncAri("hotel");
    expect(results.some((result) => !result.ok)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
    const bodies = transport.mock.calls.map((call) => String((call[1] as RequestInit).body));
    expect(bodies.join("")).not.toContain('Count="5"');
    expect(bodies[0]).toContain('Status="Close"');
  });

  it("sends one message for an availability-only delta and no empty OTA messages", async () => {
    mocks.collect.mockResolvedValueOnce({ rates: [], avail: [], inventory: [payload.inventory[0]] });
    const scope = { availability: [{ roomId: "closed", dates: ["2026-10-01"] }], products: [] };
    await syncAri("hotel", scope);
    expect(mocks.collect).toHaveBeenCalledWith("hotel", { from: "2026-10-01", to: "2026-10-03" }, scope);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0][0])).toContain("hotel_inv_count_notif");
  });

  it("periodic reconciliation cannot clear a durable OFF latch using a stale KV flag", async () => {
    await scheduledGoogleAriSync();
    expect(mocks.submit).toHaveBeenCalledWith({ pid: "hotel", kinds: ["property_data", "ari", "taxes", "promotions"] });
    expect(mocks.submit.mock.calls[0][0]).not.toHaveProperty("transition");
  });
});
