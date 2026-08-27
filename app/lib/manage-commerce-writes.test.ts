import { describe, expect, it, vi } from "vitest";

// Extras + promotions writes, plus the wiring invariant: every advertised MCP
// tool must have an in-process handler (set_tax_config once shipped without
// one — a tool that lists fine and fails at call time).

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

vi.mock("cloudflare:workers", () => ({
  env: { CONFIG_KV: kv },
  waitUntil: () => {},
}));

const jsonReq = (path: string, key: string, method: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup() {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa Test" }]));
  store.set("settings:p1", JSON.stringify({ currency: "EUR" }));
  store.set("catalog_rooms:p1", JSON.stringify([{ id: "room1", title: "Double", images: [], maxAdults: 2, maxGuests: 2, facilities: [], position: 0, createdAt: "2026-01-01" }]));
  const { issueApiKey } = await import("./api-auth.server");
  const { raw } = await issueApiKey("p1", { label: "c", mode: "live", scope: "manage" });
  return raw;
}
const akPromise = setup();

describe("extras writes", () => {
  it("creates, edits and deletes an extra with real validation", async () => {
    const ak = await akPromise;
    const extras = await import("../routes/api.v1.manage.extras");
    const extra = await import("../routes/api.v1.manage.extras.$id");

    const badUnit = (await extras.action({ request: jsonReq("/v1/manage/extras", ak, "POST", { name: "Breakfast", unit: "per_meal" }) } as never)) as Response;
    expect(badUnit.status).toBe(422);
    const badRoom = (await extras.action({
      request: jsonReq("/v1/manage/extras", ak, "POST", { name: "Breakfast", unit: "person_night", exclude_rooms: ["ghost"] }),
    } as never)) as Response;
    expect(badRoom.status).toBe(422);

    const created = (await extras.action({
      request: jsonReq("/v1/manage/extras", ak, "POST", {
        name: "Airport pickup",
        unit: "trip",
        scope: "booking",
        options: [{ name: "Sedan", price: 35 }, { name: "Van", price: 55 }],
        fields: [{ label: "Flight number", required: true }],
      }),
    } as never)) as Response;
    expect(created.status).toBe(201);
    const { data: x } = (await created.json()) as { data: { id: string; taxable: boolean; options: { id: string }[] } };
    expect(x.taxable).toBe(true); // default-on rule preserved
    expect(x.options[0].id).toBeTruthy(); // server-assigned option ids

    const patched = (await extra.action({
      request: jsonReq(`/v1/manage/extras/${x.id}`, ak, "PATCH", { taxable: false, exclude_rooms: ["room1"] }),
      params: { id: x.id },
    } as never)) as Response;
    const patchedJson = (await patched.json()) as { data: { taxable: boolean; exclude_rooms: string[]; options: unknown[] } };
    expect(patchedJson.data.taxable).toBe(false);
    expect(patchedJson.data.exclude_rooms).toEqual(["room1"]);
    expect(patchedJson.data.options).toHaveLength(2); // untouched by sparse PATCH

    const gone = (await extra.action({ request: jsonReq(`/v1/manage/extras/${x.id}`, ak, "DELETE"), params: { id: x.id } } as never)) as Response;
    expect(((await gone.json()) as { deleted: boolean }).deleted).toBe(true);
    expect(store.has("extras_seeded:p1")).toBe(false); // still never demo-seeded
  });
});

describe("promotion writes", () => {
  it("enforces the cross-field rules and code uniqueness", async () => {
    const ak = await akPromise;
    const promos = await import("../routes/api.v1.manage.promotions");
    const promo = await import("../routes/api.v1.manage.promotions.$id");

    const noCode = (await promos.action({ request: jsonReq("/v1/manage/promotions", ak, "POST", { trigger: "code", type: "percent", value: 10 }) } as never)) as Response;
    expect(noCode.status).toBe(422);

    const created = (await promos.action({
      request: jsonReq("/v1/manage/promotions", ak, "POST", { trigger: "code", code: "save 10", type: "percent", value: 10 }),
    } as never)) as Response;
    expect(created.status).toBe(201);
    const { data: p } = (await created.json()) as { data: { id: string; code: string } };
    expect(p.code).toBe("SAVE10"); // normalized

    const dup = (await promos.action({
      request: jsonReq("/v1/manage/promotions", ak, "POST", { trigger: "code", code: "SAVE10", type: "fixed", value: 5 }),
    } as never)) as Response;
    expect(dup.status).toBe(422);

    // Auto value-add: needs inclusions + value 0 + (as a discount would) no code.
    const badValueAdd = (await promos.action({
      request: jsonReq("/v1/manage/promotions", ak, "POST", { trigger: "auto", kind: "value_add", type: "percent", value: 10 }),
    } as never)) as Response;
    expect(badValueAdd.status).toBe(422);
    const valueAdd = (await promos.action({
      request: jsonReq("/v1/manage/promotions", ak, "POST", {
        trigger: "auto", kind: "value_add", type: "percent", value: 0, name: "Stay 7+ nights",
        inclusions: ["Free dinner for two"], conditions: { min_nights: 7 }, published: true,
      }),
    } as never)) as Response;
    expect(valueAdd.status).toBe(201);

    // A sparse PATCH can't break the pair rules: flipping kind alone is caught
    // on the merged record.
    const flipped = (await promo.action({
      request: jsonReq(`/v1/manage/promotions/${p.id}`, ak, "PATCH", { kind: "value_add" }),
      params: { id: p.id },
    } as never)) as Response;
    expect(flipped.status).toBe(422);
  });
});

describe("MCP wiring invariant", () => {
  it("every advertised tool has an in-process handler", async () => {
    const { publicToolList, toolByName } = await import("./mcp");
    const { HANDLERS } = await import("./mcp-handlers.server");
    for (const scope of ["book", "manage"] as const) {
      for (const { name } of publicToolList(scope)) {
        const tool = toolByName(name)!;
        expect(HANDLERS[`${tool.route.method} ${tool.route.path}`], `${name} → ${tool.route.method} ${tool.route.path}`).toBeDefined();
      }
    }
  });
});
