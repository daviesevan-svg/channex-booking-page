import { describe, expect, it, vi } from "vitest";

// Key scopes are the whole security story of the management API: a booking key
// must never authenticate a manage endpoint and vice versa, and every key
// issued before scopes existed must keep working as a booking key. Runs the
// real issue/authenticate code against an in-memory KV.

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

// A key only authenticates for a property that still exists in the registry.
store.set(
  "properties",
  JSON.stringify([
    { id: "p1", name: "One", owner: "o@example.com" },
    { id: "p2", name: "Two", owner: "o@example.com" },
  ]),
);

const req = (key?: string) =>
  new Request("http://localhost/v1/anything", {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });

describe("API key scopes", () => {
  it("booking keys work on booking scope and are refused on manage", async () => {
    const { issueApiKey, authenticateApiKey } = await import("./api-auth.server");
    const { raw } = await issueApiKey("p1", { label: "book", mode: "test" });
    expect(raw.startsWith("sk_test_")).toBe(true);

    const ok = await authenticateApiKey(req(raw));
    expect(ok).toMatchObject({ pid: "p1", mode: "test", scope: "book" });

    const refused = await authenticateApiKey(req(raw), "manage");
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(403);
    expect((await (refused as Response).json()).error.type).toBe("wrong_key_scope");
  });

  it("manage keys are ak_live_, work on manage scope, and are refused on booking", async () => {
    const { issueApiKey, authenticateApiKey } = await import("./api-auth.server");
    // mode "test" is deliberately ignored: there is no test variant of a write.
    const { raw, key } = await issueApiKey("p1", { label: "manage", mode: "test", scope: "manage" });
    expect(raw.startsWith("ak_live_")).toBe(true);
    expect(key.mode).toBe("live");
    expect(key.scope).toBe("manage");

    const ok = await authenticateApiKey(req(raw), "manage");
    expect(ok).toMatchObject({ pid: "p1", mode: "live", scope: "manage" });

    const refused = await authenticateApiKey(req(raw));
    expect((refused as Response).status).toBe(403);
  });

  it("legacy records without a scope field authenticate as booking keys", async () => {
    const { issueApiKey, authenticateApiKey } = await import("./api-auth.server");
    const { raw } = await issueApiKey("p2", { label: "old", mode: "live" });
    // Strip `scope` from both the record and the reverse index, as a key
    // issued before this PR would be stored.
    for (const [k, v] of store) {
      if (k.startsWith("api_keys:p2") || v.includes('"keyId"')) {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) parsed.forEach((r) => delete r.scope);
        else delete parsed.scope;
        store.set(k, JSON.stringify(parsed));
      }
    }
    const ok = await authenticateApiKey(req(raw));
    expect(ok).toMatchObject({ pid: "p2", scope: "book" });
    const refused = await authenticateApiKey(req(raw), "manage");
    expect((refused as Response).status).toBe(403);
  });

  it("revoked manage keys stop authenticating; malformed keys are 401", async () => {
    const { issueApiKey, revokeApiKey, authenticateApiKey } = await import("./api-auth.server");
    const { raw, key } = await issueApiKey("p3", { label: "gone", mode: "live", scope: "manage" });
    await revokeApiKey("p3", key.id);
    expect(((await authenticateApiKey(req(raw), "manage")) as Response).status).toBe(401);
    expect(((await authenticateApiKey(req("ak_live_nonsense"), "manage")) as Response).status).toBe(401);
    expect(((await authenticateApiKey(req(), "manage")) as Response).status).toBe(401);
  });
});
