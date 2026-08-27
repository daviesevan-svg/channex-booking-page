import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// Voucher catalog + brand + reviews. Pins: package cross-field rules, the
// loud brand vocabulary (vs the UI's silent keep), and the respond-only
// review contract (no hide/delete anywhere on the surface).

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
const fakeD1 = { prepare: (sql: string) => makeStmt(sql), batch: async (stmts: Stmt[]) => stmts.map(exec) };

vi.mock("cloudflare:workers", () => ({
  env: { CONFIG_KV: kv, DB: fakeD1 },
  waitUntil: () => {},
}));

const req = (path: string, key: string, method = "GET", body?: unknown) =>
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
  const { raw } = await issueApiKey("p1", { label: "v", mode: "live", scope: "manage" });
  return raw;
}
const akPromise = setup();

describe("voucher products", () => {
  it("enforces package rules and keeps kinds honest", async () => {
    const ak = await akPromise;
    const products = await import("../routes/api.v1.manage.voucher-products");
    const product = await import("../routes/api.v1.manage.voucher-products.$id");

    const noRules = (await products.action({
      request: req("/v1/manage/voucher-products", ak, "POST", { kind: "package", title: "Two-night escape", price: 400, expires_months: 12 }),
    } as never)) as Response;
    expect(noRules.status).toBe(422);

    const giftWithRules = (await products.action({
      request: req("/v1/manage/voucher-products", ak, "POST", {
        kind: "gift", title: "Gift card", price: 100, expires_months: 12,
        package: { nights: 2, adults: 2, room_ids: ["room1"] },
      }),
    } as never)) as Response;
    expect(giftWithRules.status).toBe(422);

    const created = (await products.action({
      request: req("/v1/manage/voucher-products", ak, "POST", {
        kind: "package", title: "Two-night escape", price: 400, expires_months: 12, guests: 2,
        included: ["Two nights", "Breakfast", "Late checkout"],
        package: { nights: 2, adults: 2, room_ids: ["room1"], checkin_days: [5, 6], blocked_ranges: [{ from: "2026-12-24", to: "2026-12-31" }] },
      }),
    } as never)) as Response;
    expect(created.status).toBe(201);
    const { data: p } = (await created.json()) as { data: { id: string; package: { checkin_days: number[] } } };
    expect(p.package.checkin_days).toEqual([5, 6]);

    const patched = (await product.action({
      request: req(`/v1/manage/voucher-products/${p.id}`, ak, "PATCH", { price: 450, active: false }),
      params: { id: p.id },
    } as never)) as Response;
    const patchedJson = (await patched.json()) as { data: { price: number; active: boolean; package: unknown } };
    expect(patchedJson.data).toMatchObject({ price: 450, active: false });
    expect(patchedJson.data.package).toBeTruthy(); // untouched by sparse PATCH

    const deleted = (await product.action({ request: req(`/v1/manage/voucher-products/${p.id}`, ak, "DELETE"), params: { id: p.id } } as never)) as Response;
    expect(((await deleted.json()) as { note: string }).note).toMatch(/stay redeemable/);
  });
});

describe("brand", () => {
  it("is loud where the UI is silent, and null clears", async () => {
    const ak = await akPromise;
    const brand = await import("../routes/api.v1.manage.brand");

    const badFont = (await brand.action({ request: req("/v1/manage/brand", ak, "PATCH", { font: "comic-sans" }) } as never)) as Response;
    expect(badFont.status).toBe(422);
    const badColor = (await brand.action({ request: req("/v1/manage/brand", ak, "PATCH", { custom_color: "reddish" }) } as never)) as Response;
    expect(badColor.status).toBe(422);

    const ok = (await brand.action({
      request: req("/v1/manage/brand", ak, "PATCH", { theme: "custom", custom_color: "2F5D50", font: "lora-worksans" }),
    } as never)) as Response;
    const json = (await ok.json()) as { data: { theme: string; custom_color: string; font: string; themes: unknown[]; fonts: unknown[] } };
    expect(json.data).toMatchObject({ theme: "custom", custom_color: "#2f5d50", font: "lora-worksans" });
    expect(json.data.themes.length).toBeGreaterThan(0);

    await brand.action({ request: req("/v1/manage/brand", ak, "PATCH", { theme: null, custom_color: null, font: null }) } as never);
    const settings = JSON.parse(store.get("settings:p1")!);
    expect("theme" in settings).toBe(false);
    expect("customColor" in settings).toBe(false);
    expect("themeFont" in settings).toBe(false);
  });
});

describe("reviews", () => {
  it("lists the admin view and supports respond-only", async () => {
    const ak = await akPromise;
    const { upsertReview } = await import("./reviews.server");
    await upsertReview("p1", {
      bookingId: "b1",
      stars: 4,
      categories: {},
      publicText: "Lovely stay, slow breakfast.",
      privateNote: "The coffee machine was broken.",
      guestName: "An N.",
      checkin: "2026-07-01",
      checkout: "2026-07-04",
    } as never);

    const reviews = await import("../routes/api.v1.manage.reviews");
    const list = (await reviews.loader({ request: req("/v1/manage/reviews", ak) } as never)) as Response;
    const listJson = (await list.json()) as { data: { booking_id: string; private_note: string; response: unknown }[] };
    expect(listJson.data[0]).toMatchObject({ booking_id: "b1", private_note: "The coffee machine was broken.", response: null });

    const respond = await import("../routes/api.v1.manage.reviews.$id.response");
    const missing = (await respond.action({ request: req("/v1/manage/reviews/ghost/response", ak, "POST", { text: "x" }), params: { id: "ghost" } } as never)) as Response;
    expect(missing.status).toBe(404);

    const replied = (await respond.action({
      request: req("/v1/manage/reviews/b1/response", ak, "POST", { text: "Thank you — the breakfast pace is fixed." }),
      params: { id: "b1" },
    } as never)) as Response;
    expect(((await replied.json()) as { data: { response: { text: string } } }).data.response.text).toMatch(/breakfast pace/);

    const cleared = (await respond.action({ request: req("/v1/manage/reviews/b1/response", ak, "POST", { text: null }), params: { id: "b1" } } as never)) as Response;
    expect(((await cleared.json()) as { data: { response: unknown } }).data.response).toBeNull();

    // The respond-only contract: no manage tool or route offers hide/delete.
    const { publicToolList } = await import("./mcp");
    const names = publicToolList("manage").map((t) => t.name).join(" ");
    expect(names).not.toMatch(/hide_review|delete_review/);
  });
});
