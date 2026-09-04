import { beforeEach, describe, expect, it, vi } from "vitest";

// Who may EDIT /admin/payments. PR 480 gated every intent on `isOwnerOrSuper`,
// which left a teammate the owner had granted the `payments` area staring at a
// read-only page. The gate is now the area grant itself, enforced where every
// other admin page is enforced — assertMemberAreaAllowed on the property
// resolver, which runs for the POST too because the action's pathname is
// /admin/payments. These tests assert the stored config, not the returned
// message: the question is whether the write actually landed.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

vi.mock("cloudflare:workers", () => ({
  // A claimed env superadmin, so createAdminSession's bootstrap claim is a
  // no-op — otherwise the first sign-in in this file becomes superadmin and
  // every assertion below passes for the wrong reason.
  env: { CONFIG_KV: kv, SESSION_SECRET: "test-secret", SUPERADMIN_EMAILS: "boss@example.com", APP_URL: "http://localhost" },
  waitUntil: () => {},
}));

const OWNER = "owner@example.com";
const STAFF = "staff@example.com";

function seed(hiddenAreas?: Record<string, string[]>) {
  store.clear();
  store.set(
    "properties",
    JSON.stringify([
      { id: "p1", name: "Casa Test", owner: OWNER, members: [STAFF], ...(hiddenAreas ? { memberHiddenAreas: hiddenAreas } : {}) },
    ]),
  );
  store.set("settings:p1", JSON.stringify({ currency: "EUR" }));
  store.set(
    "viva_config:p1",
    JSON.stringify({ merchantId: "m", apiKey: "k", clientId: "c", clientSecret: "s", sourceCode: "1234" }),
  );
}

async function cookieFor(email: string) {
  const { createAdminSession } = await import("./auth.server");
  const res = await createAdminSession(email, "/admin");
  return res.headers.get("Set-Cookie")!.split(";")[0];
}

function disconnectViva(cookie: string) {
  return new Request("http://localhost/admin/payments", {
    method: "POST",
    headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "viva-disconnect" }),
  });
}

describe("/admin/payments write access", () => {
  beforeEach(() => seed());

  it("lets a teammate with the payments area disconnect the gateway", async () => {
    const { action } = await import("../routes/admin/payments");
    const result = await action({ request: disconnectViva(await cookieFor(STAFF)) } as never);
    expect(result).toEqual({ ok: true });
    expect(store.has("viva_config:p1")).toBe(false);
  });

  it("still 404s a teammate the owner hid the payments area from", async () => {
    seed({ [STAFF]: ["payments"] });
    const { action } = await import("../routes/admin/payments");
    const cookie = await cookieFor(STAFF);
    await expect(action({ request: disconnectViva(cookie) } as never)).rejects.toMatchObject({ status: 404 });
    expect(store.has("viva_config:p1")).toBe(true);
  });

  it("still lets the owner disconnect", async () => {
    const { action } = await import("../routes/admin/payments");
    const result = await action({ request: disconnectViva(await cookieFor(OWNER)) } as never);
    expect(result).toEqual({ ok: true });
    expect(store.has("viva_config:p1")).toBe(false);
  });
});
