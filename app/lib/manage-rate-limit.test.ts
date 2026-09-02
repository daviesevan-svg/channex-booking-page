import { describe, expect, it, vi } from "vitest";

// The management surface is throttled per key (docs/management-api.md §2) and
// auto_refund is readable but not writable through it. Runs the real
// authenticate + route code over an in-memory KV.

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

store.set("properties", JSON.stringify([{ id: "p1", name: "One", owner: "o@example.com" }]));
store.set("settings:p1", JSON.stringify({ currency: "GBP" }));

const req = (key: string, method: string, path = "/v1/manage/property", body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("management rate limits", () => {
  it("allows 60 writes then 429s; reads have their own, larger bucket", async () => {
    const { issueApiKey, authenticateApiKey, MANAGE_WRITE_LIMIT } = await import("./api-auth.server");
    const { raw } = await issueApiKey("p1", { label: "t", mode: "live", scope: "manage" });
    for (let i = 0; i < MANAGE_WRITE_LIMIT; i++) {
      const a = await authenticateApiKey(req(raw, "PATCH"), "manage");
      expect(a).toMatchObject({ pid: "p1" });
    }
    const over = await authenticateApiKey(req(raw, "PATCH"), "manage");
    expect(over).toBeInstanceOf(Response);
    expect((over as Response).status).toBe(429);
    expect(((await (over as Response).json()) as { error: { type: string } }).error.type).toBe("rate_limited");
    // Reads still flow — separate bucket.
    expect(await authenticateApiKey(req(raw, "GET"), "manage")).toMatchObject({ pid: "p1" });
  });

  it("does not touch booking keys", async () => {
    const { issueApiKey, authenticateApiKey } = await import("./api-auth.server");
    const { raw } = await issueApiKey("p1", { label: "b", mode: "live" });
    for (let i = 0; i < 80; i++) {
      expect(await authenticateApiKey(req(raw, "POST", "/v1/bookings"), "book")).toMatchObject({ pid: "p1", scope: "book" });
    }
  });

  it("refuses portal.auto_refund with a pointer to the admin", async () => {
    const { issueApiKey } = await import("./api-auth.server");
    const { raw } = await issueApiKey("p1", { label: "t2", mode: "live", scope: "manage" });
    const route = await import("../routes/api.v1.manage.property");
    const res = (await route.action({ request: req(raw, "PATCH", "/v1/manage/property", { portal: { auto_refund: true } }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/owner-only/);
    expect(JSON.parse(store.get("settings:p1")!).autoRefund).toBeUndefined();
    // The rest of the portal block still writes.
    const ok = (await route.action({ request: req(raw, "PATCH", "/v1/manage/property", { portal: { allow_cancel: true } }) } as never)) as Response;
    expect(ok.status).toBe(200);
    expect(JSON.parse(store.get("settings:p1")!).allowCancel).toBe(true);
  });

  it("caps MCP batches", async () => {
    const mcp = await import("../routes/mcp");
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/list" }));
    const res = (await mcp.action({
      request: new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) }),
    } as never)) as Response;
    expect(res.status).toBe(400);
  });
});
