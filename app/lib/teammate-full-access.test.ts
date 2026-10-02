import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1 } from "./test-d1";

// "Full access" on the Team page: a teammate the owner trusts with the manager
// pages (widget, API keys, webhooks, team, …) without making them the owner.
// These assert what ends up STORED and what the routes then return, not the
// shape of a redirect: the question is whether the grant really lands, can't be
// forged by an ordinary teammate, and never reaches owner-only settings.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

// The registry is D1 rows (KV "properties" is only the legacy snapshot it
// migrates from), so each test gets a fresh database and fresh module state.
const env = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("cloudflare:workers", () => ({ env, waitUntil: () => {} }));

const OWNER = "owner@example.com";
const STAFF = "staff@example.com";
const OTHER = "other@example.com";

function seed(extra: Record<string, unknown> = {}) {
  vi.resetModules();
  store.clear();
  Object.assign(env, {
    DB: makeTestD1().d1,
    CONFIG_KV: kv,
    SESSION_SECRET: "test-secret",
    SUPERADMIN_EMAILS: "boss@example.com",
    APP_URL: "http://localhost",
  });
  store.set(
    "properties",
    JSON.stringify([{ id: "p1", name: "Casa Test", owner: OWNER, members: [STAFF, OTHER], ...extra }]),
  );
  store.set("settings:p1", JSON.stringify({ currency: "EUR" }));
}

// Through the real accessor: the registry is D1 rows, the KV key is only the
// legacy snapshot it migrates from, so reading the key would assert on a stale copy.
/** Runs a route action; a thrown Response (redirect / 404) is a result, anything
 *  else is a real failure and must fail the test rather than be swallowed. */
async function run(fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

const registry = async () => {
  const { getProperty } = await import("./properties.server");
  return (await getProperty("p1")) as unknown as Record<string, unknown>;
};

async function cookieFor(email: string) {
  const { createAdminSession } = await import("./auth.server");
  const res = await createAdminSession(email, "/admin");
  return res.headers.get("Set-Cookie")!.split(";")[0];
}

function teamPost(cookie: string, body: Record<string, string>) {
  return new Request("http://localhost/admin/team", {
    method: "POST",
    headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

async function widgetCanManage(email: string) {
  const { loader } = await import("../routes/admin/website-widget");
  const res = (await loader({
    request: new Request("http://localhost/admin/website-widget", { headers: { Cookie: await cookieFor(email) } }),
  } as never)) as { canManage?: boolean };
  return res.canManage;
}

describe("teammate full access", () => {
  beforeEach(() => seed());

  it("an ordinary teammate cannot manage the widget; after the owner grants full access they can", async () => {
    expect(await widgetCanManage(STAFF)).toBe(false);
    const { action } = await import("../routes/admin/team");
    await run(async () => action({
      request: teamPost(await cookieFor(OWNER), { intent: "full-access", email: STAFF, on: "1" }),
    } as never));
    expect((await registry()).fullAccess).toEqual([STAFF]);
    expect(await widgetCanManage(STAFF)).toBe(true);
    // The other teammate is untouched.
    expect(await widgetCanManage(OTHER)).toBe(false);
  });

  it("granting clears a stale hide list, and a hidden area no longer binds a full-access teammate", async () => {
    seed({ memberHiddenAreas: { [STAFF]: ["pricing", "website"] } });
    const { action } = await import("../routes/admin/team");
    await run(async () => action({ request: teamPost(await cookieFor(OWNER), { intent: "full-access", email: STAFF, on: "1" }) } as never));
    expect((await registry()).memberHiddenAreas).toBeUndefined();

    // Even a hide list that sneaks back in (older write, forged POST) is ignored.
    seed({ fullAccess: [STAFF], memberHiddenAreas: { [STAFF]: ["pricing"] } });
    const { loader } = await import("../routes/admin/rates");
    const res = loader({
      request: new Request("http://localhost/admin/rates", { headers: { Cookie: await cookieFor(STAFF) } }),
    } as never);
    await expect(res).resolves.not.toMatchObject({ status: 404 });
  });

  it("a teammate cannot grant themselves full access", async () => {
    const { action } = await import("../routes/admin/team");
    // An ordinary teammate is bounced from the Team page before the intent runs.
    await run(async () => action({ request: teamPost(await cookieFor(STAFF), { intent: "full-access", email: STAFF, on: "1" }) } as never));
    expect((await registry()).fullAccess).toBeUndefined();
  });

  it("a full-access teammate can manage the team but cannot pass full access on", async () => {
    seed({ fullAccess: [STAFF] });
    const { action } = await import("../routes/admin/team");
    await run(async () => action({ request: teamPost(await cookieFor(STAFF), { intent: "full-access", email: OTHER, on: "1" }) } as never));
    expect((await registry()).fullAccess).toEqual([STAFF]);
  });

  it("a full-access teammate still cannot flip owner-only settings", async () => {
    seed({ fullAccess: [STAFF] });
    const { isOwnerOrSuper } = await import("./properties.server");
    const req = new Request("http://localhost/admin/general", { headers: { Cookie: await cookieFor(STAFF) } });
    expect(await isOwnerOrSuper(req, "p1")).toBe(false);
  });

  it("revoking, or removing the teammate, takes the access away and leaves no stale entry", async () => {
    seed({ fullAccess: [STAFF, OTHER] });
    const { action } = await import("../routes/admin/team");
    const owner = await cookieFor(OWNER);
    await run(async () => action({ request: teamPost(owner, { intent: "full-access", email: STAFF, on: "0" }) } as never));
    expect((await registry()).fullAccess).toEqual([OTHER]);
    await run(async () => action({ request: teamPost(owner, { intent: "remove", email: OTHER }) } as never));
    expect((await registry()).fullAccess).toBeUndefined();
    expect((await registry()).members).toEqual([STAFF]);
  });

  it("full access cannot be used to add someone who is not on the team", async () => {
    const { action } = await import("../routes/admin/team");
    await run(async () => action({ request: teamPost(await cookieFor(OWNER), { intent: "full-access", email: "stranger@example.com", on: "1" }) } as never));
    expect((await registry()).fullAccess).toBeUndefined();
  });
});
