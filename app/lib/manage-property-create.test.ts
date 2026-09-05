import { describe, expect, it, vi } from "vitest";
import { makeTestD1, seedProperties } from "./test-d1";

// The registry is D1-backed; these tests exercise property create/rename/team.
const { d1: testD1, sqlite: testSqlite } = makeTestD1();

// POST /v1/manage/properties — creating a sibling property from a management
// key. What these pin: owner + partnerId come from the key property's registry
// record; the response's minted key really authenticates against the NEW
// property (and only there); ownerless key properties are refused; the
// per-owner cap holds; validation is loud.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

vi.mock("cloudflare:workers", () => ({
  env: { DB: testD1, CONFIG_KV: kv },
  waitUntil: () => {},
}));

const jsonReq = (path: string, key: string, method: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup() {
  store.set(
    "properties",
    JSON.stringify([
      { id: "p1", name: "Casa Test", owner: "owner@example.com", partnerId: "hotelsoft" },
      { id: "p2", name: "Unclaimed" }, // ownerless — legacy/unregistered
    ]),
  );
  const { issueApiKey } = await import("./api-auth.server");
  const { raw: ak } = await issueApiKey("p1", { label: "t", mode: "live", scope: "manage" });
  const { raw: akOwnerless } = await issueApiKey("p2", { label: "t", mode: "live", scope: "manage" });
  return { ak, akOwnerless };
}
const keys = setup();

describe("management API: create property", () => {
  it("creates a sibling property owned like the key's, and the minted key opens only it", async () => {
    const { ak } = await keys;
    const route = await import("../routes/api.v1.manage.properties");
    const propertyRoute = await import("../routes/api.v1.manage.property");
    const { getProperty } = await import("./properties.server");

    // Loud validation: missing name / unknown fields are named.
    const bad = (await route.action({ request: jsonReq("/v1/manage/properties", ak, "POST", { title: "x" }) } as never)) as Response;
    expect(bad.status).toBe(422);
    const badJson = (await bad.json()) as { error: { fields: Record<string, string[]> } };
    expect(badJson.error.fields.name).toEqual(["Required."]);
    expect(badJson.error.fields.title).toEqual(["Unknown field."]);

    const created = (await route.action({
      request: jsonReq("/v1/manage/properties", ak, "POST", { name: "Casa Nova" }),
    } as never)) as Response;
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string; name: string; api_key: string } };
    expect(data.name).toBe("Casa Nova");
    expect(data.api_key).toMatch(/^ak_live_/);

    // Registry: owner and partner copied from the key's property record.
    const ref = await getProperty(data.id);
    expect(ref).toMatchObject({ name: "Casa Nova", owner: "owner@example.com", partnerId: "hotelsoft" });

    // The minted key authenticates for the NEW property...
    const viaNewKey = (await propertyRoute.loader({
      request: jsonReq("/v1/manage/property", data.api_key, "GET"),
    } as never)) as Response;
    expect(viaNewKey.status).toBe(200);
    const settings = (await viaNewKey.json()) as { data: { id: string } };
    expect(settings.data.id).toBe(data.id);

    // ...while the original key keeps answering for the ORIGINAL property.
    const viaOldKey = (await propertyRoute.loader({
      request: jsonReq("/v1/manage/property", ak, "GET"),
    } as never)) as Response;
    expect(((await viaOldKey.json()) as { data: { id: string } }).data.id).toBe("p1");
  });

  it("refuses an ownerless key property", async () => {
    const { akOwnerless } = await keys;
    const route = await import("../routes/api.v1.manage.properties");
    const res = (await route.action({
      request: jsonReq("/v1/manage/properties", akOwnerless, "POST", { name: "Orphan" }),
    } as never)) as Response;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("no_owner");
  });

  it("caps properties per owner", async () => {
    const { ak } = await keys;
    const route = await import("../routes/api.v1.manage.properties");
    // Seed the ROWS: the registry is a table now, and a legacy KV value nothing
    // reads back would leave the owner under the cap and the assertion vacuous.
    seedProperties(
      testSqlite,
      Array.from({ length: 50 }, (_, i) => ({ id: `cap-${i}`, name: "x", owner: "owner@example.com" })),
    );
    const res = (await route.action({
      request: jsonReq("/v1/manage/properties", ak, "POST", { name: "One too many" }),
    } as never)) as Response;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("property_limit");
  });

  it("refuses booking-scoped keys", async () => {
    await keys;
    const { issueApiKey } = await import("./api-auth.server");
    const { raw: sk } = await issueApiKey("p1", { label: "b", mode: "live", scope: "book" });
    const route = await import("../routes/api.v1.manage.properties");
    const res = (await route.action({
      request: jsonReq("/v1/manage/properties", sk, "POST", { name: "Nope" }),
    } as never)) as Response;
    expect(res.status).toBe(403);
  });
});
