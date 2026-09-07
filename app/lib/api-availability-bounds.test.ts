import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  getCatalogRooms: vi.fn(async () => []), getRates: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({ currency: "GBP" })),
  authenticateApiKey: vi.fn(async () => ({ pid: "p1" })),
}));
vi.mock("./api-auth.server", () => ({
  authenticateApiKey: deps.authenticateApiKey,
  apiError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
}));
vi.mock("./catalog.server", () => ({ getCatalogRooms: deps.getCatalogRooms, getRates: deps.getRates }));
vi.mock("./overrides.server", () => ({ getSettings: deps.getSettings }));
import { loader } from "../routes/api.v1.availability";

const request = (extra: Record<string, string> = {}) => loader({ request: new Request(`https://example.com/v1/availability?${new URLSearchParams({ checkin: "2028-02-01", checkout: "2028-02-02", ...extra })}`) } as never);

beforeEach(() => vi.clearAllMocks());

describe("availability input bounds", () => {
  it.each([
    { checkin: "2028-02-30" }, { checkin: "2027-02-29", checkout: "2027-03-01" },
    { checkout: "2028-13-01" }, { checkin: "2028-00-01" }, { checkin: "not-a-date" },
    { checkout: "2028-02-01" }, { checkout: "2028-01-31" }, { checkout: "2028-04-02" },
    { checkout: "9999-12-31" }, { adults: "26" }, { adults: "0" }, { adults: "2.5" },
    { adults: "2junk" }, { children: "1000000000" }, { children: "-1" }, { children: "2.5" },
    { children_ages: "1,18" }, { children_ages: "-1" }, { children_ages: "1,,4" },
    { children_ages: "4junk" }, { children_ages: "4.5" },
    { children_ages: Array(26).fill("1").join(",") }, { children_ages: "1,".repeat(10000) },
    { children: "999999999999", children_ages: "4" },
  ])("rejects %j without reading settings or inventory", async (input) => {
    const response = await request(input);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(deps.getSettings).not.toHaveBeenCalled();
    expect(deps.getRates).not.toHaveBeenCalled();
    expect(deps.getCatalogRooms).not.toHaveBeenCalled();
  });

  it("accepts leap dates and the exact 60-night, 25-adult and 25-child boundaries", async () => {
    const response = await request({ checkout: "2028-04-01", adults: "25", children: "25" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ nights: 60, currency: "GBP" });
    expect(deps.getCatalogRooms).toHaveBeenCalledWith("p1", expect.objectContaining({ adults: 25, childrenAge: Array(25).fill(8) }), expect.anything());
  });

  it("preserves defaults and age-list precedence, including infants", async () => {
    await request();
    expect(deps.getCatalogRooms).toHaveBeenLastCalledWith("p1", expect.objectContaining({ adults: 2, childrenAge: [] }), expect.anything());
    const response = await request({ checkin: "2028-02-29", checkout: "2028-03-01", children: "3", children_ages: "0, 17" });
    expect(response.status).toBe(200);
    expect(deps.getCatalogRooms).toHaveBeenLastCalledWith("p1", expect.objectContaining({ childrenAge: [0, 17] }), expect.anything());
  });
});
