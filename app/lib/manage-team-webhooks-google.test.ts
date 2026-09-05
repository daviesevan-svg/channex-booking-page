import { describe, expect, it, vi } from "vitest";
import { makeTestD1 } from "./test-d1";

// The registry is D1-backed; these tests exercise property create/rename/team.
const { d1: testD1 } = makeTestD1();

// Team, webhooks, Google push. Pins: the invite's user-precreation rules and
// property scoping, the visible-areas ↔ stored-complement translation, the
// webhook SSRF gate + secret-shown-once rule, and the Google toggle computing
// its side effect from the PRE-write value.

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

const req = (path: string, key: string, method = "GET", body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup() {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa Test", owner: "evan@example.com" }]));
  store.set("settings:p1", JSON.stringify({ singleUnit: false }));
  const { issueApiKey } = await import("./api-auth.server");
  const { raw } = await issueApiKey("p1", { label: "t", mode: "live", scope: "manage" });
  return raw;
}
const akPromise = setup();

describe("team", () => {
  it("invites, scopes areas via the complement, and removes", async () => {
    const ak = await akPromise;
    const team = await import("../routes/api.v1.manage.team");
    const member = await import("../routes/api.v1.manage.team.$id");

    const badEmail = (await team.action({ request: req("/v1/manage/team", ak, "POST", { email: "nope" }) } as never)) as Response;
    expect(badEmail.status).toBe(422);

    // An API invite is a REQUEST: parked as pending, owner notified, nobody
    // added and no user pre-created until the owner approves in the admin UI.
    const invited = (await team.action({ request: req("/v1/manage/team", ak, "POST", { email: "Ana@Example.com" }) } as never)) as Response;
    expect(invited.status).toBe(202);
    const pendingJson = (await invited.json()) as { data: { members: unknown[]; pending: { email: string }[] } };
    expect(pendingJson.data.members).toHaveLength(0);
    expect(pendingJson.data.pending).toEqual([expect.objectContaining({ email: "ana@example.com" })]);
    expect(store.has("user:ana@example.com")).toBe(false);
    expect(JSON.parse(store.get("properties")!)[0].members ?? []).toHaveLength(0);
    // Retrying the request doesn't duplicate the row.
    await team.action({ request: req("/v1/manage/team", ak, "POST", { email: "ana@example.com" }) } as never);
    expect(JSON.parse(store.get("pending_invites:p1")!)).toHaveLength(1);

    // The owner approves (what the admin Team page does): now a real teammate.
    const { removePendingInvite } = await import("./team-invites.server");
    const { addPropertyMember } = await import("./properties.server");
    expect(await removePendingInvite("p1", "ana@example.com")).toBe(true);
    await addPropertyMember("p1", "ana@example.com");
    const listed = (await team.loader({ request: req("/v1/manage/team", ak) } as never)) as Response;
    const teamJson = (await listed.json()) as { data: { members: { email: string; areas: string[] }[]; pending: unknown[] } };
    expect(teamJson.data.members[0]).toMatchObject({ email: "ana@example.com" });
    expect(teamJson.data.members[0].areas).toHaveLength(5); // full access by default
    expect(teamJson.data.pending).toHaveLength(0);

    const badArea = (await member.action({
      request: req("/v1/manage/team/ana%40example.com", ak, "PATCH", { areas: ["operations", "finance"] }),
      params: { id: "ana%40example.com" },
    } as never)) as Response;
    expect(badArea.status).toBe(422);

    const scoped = (await member.action({
      request: req("/v1/manage/team/ana%40example.com", ak, "PATCH", { areas: ["operations", "pricing"] }),
      params: { id: "ana%40example.com" },
    } as never)) as Response;
    const scopedJson = (await scoped.json()) as { data: { members: { areas: string[] }[] } };
    expect(scopedJson.data.members[0].areas).toEqual(["operations", "pricing"]);
    // Stored as the COMPLEMENT.
    const ref = JSON.parse(store.get("properties")!)[0];
    expect(ref.memberHiddenAreas["ana@example.com"].sort()).toEqual(["emails", "payments", "website"]);

    const removed = (await member.action({ request: req("/v1/manage/team/ana%40example.com", ak, "DELETE"), params: { id: "ana%40example.com" } } as never)) as Response;
    expect(((await removed.json()) as { removed: boolean }).removed).toBe(true);
    const ghost = (await member.action({ request: req("/v1/manage/team/ana%40example.com", ak, "DELETE"), params: { id: "ana%40example.com" } } as never)) as Response;
    expect(ghost.status).toBe(404);
  });
});

describe("webhooks", () => {
  it("refuses unsafe URLs, shows the secret once, masks it on list", async () => {
    const ak = await akPromise;
    const hooks = await import("../routes/api.v1.manage.webhooks");
    const hook = await import("../routes/api.v1.manage.webhooks.$id");

    for (const url of ["http://example.com/hook", "https://localhost/hook", "https://192.168.1.10/hook", "https://169.254.169.254/latest"]) {
      const refused = (await hooks.action({ request: req("/v1/manage/webhooks", ak, "POST", { url }) } as never)) as Response;
      expect(refused.status, url).toBe(422);
    }

    const created = (await hooks.action({
      request: req("/v1/manage/webhooks", ak, "POST", { url: "https://pms.example.com/hooks/roompanda", events: ["booking.created"] }),
    } as never)) as Response;
    expect(created.status).toBe(201);
    const { data: h } = (await created.json()) as { data: { id: string; secret: string } };
    expect(h.secret.startsWith("whsec_")).toBe(true);

    const list = (await hooks.loader({ request: req("/v1/manage/webhooks", ak) } as never)) as Response;
    const listJson = (await list.json()) as { data: { secret_last4: string; secret?: string }[] };
    expect(listJson.data[0].secret_last4).toBe(h.secret.slice(-4));
    expect(JSON.stringify(listJson)).not.toContain(h.secret); // never round-trips

    const deleted = (await hook.action({ request: req(`/v1/manage/webhooks/${h.id}`, ak, "DELETE"), params: { id: h.id } } as never)) as Response;
    expect(((await deleted.json()) as { deleted: boolean }).deleted).toBe(true);
  });
});

describe("google push", () => {
  it("validates and flips with the transition computed pre-write", async () => {
    const ak = await akPromise;
    const google = await import("../routes/api.v1.manage.google");

    const vrOnMulti = (await google.action({ request: req("/v1/manage/google", ak, "PATCH", { program: "vacation_rentals" }) } as never)) as Response;
    expect(vrOnMulti.status).toBe(422); // not single-unit

    const on = (await google.action({ request: req("/v1/manage/google", ak, "PATCH", { push: true, window_days: 180 }) } as never)) as Response;
    expect(((await on.json()) as { data: { push: boolean; window_days: number } }).data).toMatchObject({ push: true, window_days: 180 });
    const stored = JSON.parse(store.get("settings:p1")!);
    expect(stored.googleAriPush).toBe(true);

    const off = (await google.action({ request: req("/v1/manage/google", ak, "PATCH", { push: false }) } as never)) as Response;
    expect(((await off.json()) as { data: { push: boolean } }).data.push).toBe(false);
  });
});
