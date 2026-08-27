import { describe, expect, it, vi } from "vitest";

// Write-path tests for rooms + rates: real route actions over in-memory KV.
// What these pin: loud 422s (unknown fields, unknown enum values, bad image
// paths, unknown room ids), the delete-room cascade, policy → legacy mirror
// derivation, and that server-owned fields (channexRateIds) survive PATCH and
// PUT-replace but are rejected as input.

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

const POLICY = {
  payment: { timing: "pay_at_hotel", card: "guarantee" },
  cancellation: { refundable: true, tiers: [{ deadline_value: 0, deadline_unit: "days", penalty: "first_night" }] },
  no_show: { penalty: "first_night" },
};

async function setup() {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa Test" }]));
  store.set("settings:p1", JSON.stringify({ currency: "EUR" }));
  const { issueApiKey } = await import("./api-auth.server");
  const { raw } = await issueApiKey("p1", { label: "w", mode: "live", scope: "manage" });
  return raw;
}
const akPromise = setup();

describe("management API writes: rooms", () => {
  it("creates, edits and deletes a room — with loud 422s on the way", async () => {
    const ak = await akPromise;
    const rooms = await import("../routes/api.v1.manage.rooms");
    const room = await import("../routes/api.v1.manage.rooms.$id");
    const { getRooms, getRates, saveRate } = await import("./catalog.server");

    // Unknown fields and missing requireds are named, not ignored.
    const bad = (await rooms.action({ request: jsonReq("/v1/manage/rooms", ak, "POST", { name: "Double", max_adults: 2 }) } as never)) as Response;
    expect(bad.status).toBe(422);
    const badJson = (await bad.json()) as { error: { fields: Record<string, string[]> } };
    expect(badJson.error.fields.name).toEqual(["Unknown field."]);
    expect(badJson.error.fields.title).toBeDefined();
    expect(badJson.error.fields.max_guests).toBeDefined();

    const created = (await rooms.action({
      request: jsonReq("/v1/manage/rooms", ak, "POST", { title: "Double", max_adults: 2, max_guests: 3, facilities: ["Sea view"], translations: { de: { title: "Doppelzimmer" } } }),
    } as never)) as Response;
    expect(created.status).toBe(201);
    const { data: r } = (await created.json()) as { data: { id: string; position: number } };
    expect((await getRooms("p1")).map((x) => x.id)).toContain(r.id);

    // A bad image path is a 422, not a stored external URL.
    const badImg = (await room.action({ request: jsonReq(`/v1/manage/rooms/${r.id}`, ak, "PATCH", { images: ["https://evil.example/x.jpg"] }), params: { id: r.id } } as never)) as Response;
    expect(badImg.status).toBe(422);

    // Guests below adults is a contradiction, not a merge.
    const badCap = (await room.action({ request: jsonReq(`/v1/manage/rooms/${r.id}`, ak, "PATCH", { max_guests: 1 }), params: { id: r.id } } as never)) as Response;
    expect(badCap.status).toBe(422);

    const patched = (await room.action({
      request: jsonReq(`/v1/manage/rooms/${r.id}`, ak, "PATCH", { max_adults: 1, max_guests: 1, cleaning_fee: 25 }),
      params: { id: r.id },
    } as never)) as Response;
    const patchedJson = (await patched.json()) as { data: { max_guests: number; cleaning_fee: number; translations: Record<string, unknown> } };
    expect(patchedJson.data.max_guests).toBe(1);
    expect(patchedJson.data.cleaning_fee).toBe(25);
    expect(patchedJson.data.translations.de).toEqual({ title: "Doppelzimmer" }); // untouched by a sparse PATCH

    // Delete cascades: the room's price disappears from every rate.
    await saveRate("p1", { id: "rateX", title: "BAR", prices: { [r.id]: 100, other: 90 }, refundable: true, inclusions: [], active: true, createdAt: "2026-01-01" });
    const deleted = (await room.action({ request: jsonReq(`/v1/manage/rooms/${r.id}`, ak, "DELETE"), params: { id: r.id } } as never)) as Response;
    expect(((await deleted.json()) as { cascade: string }).cascade).toMatch(/removed from every rate/);
    expect((await getRates("p1")).find((x) => x.id === "rateX")?.prices).toEqual({ other: 90 });
  });
});

describe("management API writes: rates", () => {
  it("requires a policy on create, derives the legacy mirrors, and protects channex_rate_ids", async () => {
    const ak = await akPromise;
    const rooms = await import("../routes/api.v1.manage.rooms");
    const rates = await import("../routes/api.v1.manage.rates");
    const rate = await import("../routes/api.v1.manage.rates.$id");
    const { getRates, saveRate } = await import("./catalog.server");

    const created = (await rooms.action({ request: jsonReq("/v1/manage/rooms", ak, "POST", { title: "Twin", max_adults: 2, max_guests: 2 }) } as never)) as Response;
    const roomId = ((await created.json()) as { data: { id: string } }).data.id;

    const noPolicy = (await rates.action({ request: jsonReq("/v1/manage/rates", ak, "POST", { title: "Flex", prices: { [roomId]: 120 } }) } as never)) as Response;
    expect(noPolicy.status).toBe(422);
    expect(((await noPolicy.json()) as { error: { fields: Record<string, unknown> } }).error.fields.policy).toBeDefined();

    const badRoom = (await rates.action({
      request: jsonReq("/v1/manage/rates", ak, "POST", { title: "Flex", prices: { ghost: 120 }, policy: POLICY }),
    } as never)) as Response;
    expect(badRoom.status).toBe(422);

    const ok = (await rates.action({
      request: jsonReq("/v1/manage/rates", ak, "POST", { title: "Flex", prices: { [roomId]: 120 }, policy: POLICY, inclusions: ["Breakfast"] }),
    } as never)) as Response;
    expect(ok.status).toBe(201);
    const rateId = ((await ok.json()) as { data: { id: string } }).data.id;

    // Legacy mirrors derived exactly like the rate editor — including the
    // meaningful deadline 0 (PR389: never truthiness-checked away).
    const stored = (await getRates("p1")).find((r) => r.id === rateId)!;
    expect(stored.refundable).toBe(true);
    expect(stored.cancelDeadlineValue).toBe(0);
    expect(stored.cancelDeadlineUnit).toBe("days");

    // channex_rate_ids is rejected as input…
    const rejected = (await rate.action({
      request: jsonReq(`/v1/manage/rates/${rateId}`, ak, "PATCH", { channex_rate_ids: { [roomId]: "cx9" } }),
      params: { id: rateId },
    } as never)) as Response;
    expect(rejected.status).toBe(422);

    // …and survives PATCH and PUT-replace untouched.
    await saveRate("p1", { ...stored, channexRateIds: { [roomId]: "cx1" } });
    const patched = (await rate.action({ request: jsonReq(`/v1/manage/rates/${rateId}`, ak, "PATCH", { title: "Flexible" }), params: { id: rateId } } as never)) as Response;
    expect(((await patched.json()) as { data: { channex_rate_ids: Record<string, string> } }).data.channex_rate_ids).toEqual({ [roomId]: "cx1" });

    const replaced = (await rates.action({
      request: jsonReq("/v1/manage/rates", ak, "PUT", [{ id: rateId, title: "Flexible", prices: { [roomId]: 130 }, policy: POLICY }]),
    } as never)) as Response;
    const replacedJson = (await replaced.json()) as { data: { id: string; channex_rate_ids: Record<string, string>; prices: Record<string, number> }[] };
    expect(replacedJson.data[0].channex_rate_ids).toEqual({ [roomId]: "cx1" });
    expect(replacedJson.data[0].prices).toEqual({ [roomId]: 130 });
  });
});

describe("MCP write plumbing", () => {
  it("routes path params out of write bodies and scope-filters the write tools", async () => {
    const { MANAGE_WRITE_TOOLS, mapArguments, publicToolList } = await import("./mcp");
    const update = MANAGE_WRITE_TOOLS.find((t) => t.name === "update_room")!;
    const { body, pathValue } = mapArguments(update, { id: "r1", title: "New name" });
    expect(pathValue).toBe("r1");
    expect(JSON.parse(body!)).toEqual({ title: "New name" }); // id travels in the URL, not the body

    const del = MANAGE_WRITE_TOOLS.find((t) => t.name === "delete_room")!;
    expect(mapArguments(del, { id: "r1" })).toMatchObject({ pathValue: "r1" });

    const manageNames = publicToolList("manage").map((t) => t.name);
    expect(manageNames).toEqual(expect.arrayContaining(["create_room", "update_rate_plan", "delete_rate_plan"]));
    expect(publicToolList("book").map((t) => t.name)).not.toContain("create_room");
  });
});
