import { describe, expect, it, vi } from "vitest";

// Email templates + sender identity: sparse per-language template edits with
// fallback semantics, field-key validation, and the sender block riding the
// property PATCH allowlist.

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

const req = (path: string, key: string, method = "GET", body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup() {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa Test" }]));
  store.set("settings:p1", JSON.stringify({}));
  const { issueApiKey } = await import("./api-auth.server");
  const { raw } = await issueApiKey("p1", { label: "e", mode: "live", scope: "manage" });
  return raw;
}
const akPromise = setup();

describe("email templates", () => {
  it("edits one language sparsely with fallback, validating fields", async () => {
    const ak = await akPromise;
    const emails = await import("../routes/api.v1.manage.emails");
    const email = await import("../routes/api.v1.manage.emails.$id");

    const catalog = (await emails.loader({ request: req("/v1/manage/emails", ak) } as never)) as Response;
    const catalogJson = (await catalog.json()) as { data: { templates: { id: string; tokens: unknown[] }[] } };
    expect(catalogJson.data.templates.map((t) => t.id)).toContain("booking_confirmation");
    expect(catalogJson.data.templates[0].tokens.length).toBeGreaterThan(0);

    const badId = (await email.loader({ request: req("/v1/manage/emails/ghost", ak), params: { id: "ghost" } } as never)) as Response;
    expect(badId.status).toBe(404);
    const badField = (await email.action({
      request: req("/v1/manage/emails/booking_confirmation", ak, "PATCH", { body_text: "x" }),
      params: { id: "booking_confirmation" },
    } as never)) as Response;
    expect(badField.status).toBe(422);

    // English subject override, then a German one; German read shows its own
    // value stored and English's as fallback for the untouched fields.
    await email.action({
      request: req("/v1/manage/emails/booking_confirmation", ak, "PATCH", { subject: "See you soon, {guest_first_name} ({reference})" }),
      params: { id: "booking_confirmation" },
    } as never);
    await email.action({
      request: req("/v1/manage/emails/booking_confirmation?lang=de", ak, "PATCH", { heading: "Gebucht, {guest_first_name}!" }),
      params: { id: "booking_confirmation" },
    } as never);

    const de = (await email.loader({ request: req("/v1/manage/emails/booking_confirmation?lang=de", ak), params: { id: "booking_confirmation" } } as never)) as Response;
    const deJson = (await de.json()) as { data: { values: Record<string, string>; effective: Record<string, string> } };
    expect(deJson.data.values).toEqual({ heading: "Gebucht, {guest_first_name}!" });
    expect(deJson.data.effective.subject).toBe("See you soon, {guest_first_name} ({reference})"); // falls back to the EN override
    expect(deJson.data.effective.heading).toBe("Gebucht, {guest_first_name}!");

    // Clearing the German heading falls back again.
    await email.action({
      request: req("/v1/manage/emails/booking_confirmation?lang=de", ak, "PATCH", { heading: null }),
      params: { id: "booking_confirmation" },
    } as never);
    const cleared = (await email.loader({ request: req("/v1/manage/emails/booking_confirmation?lang=de", ak), params: { id: "booking_confirmation" } } as never)) as Response;
    expect(((await cleared.json()) as { data: { values: Record<string, string> } }).data.values).toEqual({});
  });
});

describe("sender identity via property PATCH", () => {
  it("validates and merges the emails block", async () => {
    const ak = await akPromise;
    const property = await import("../routes/api.v1.manage.property");

    const bad = (await property.action({
      request: req("/v1/manage/property", ak, "PATCH", { emails: { reply_to: "not-an-email" } }),
    } as never)) as Response;
    expect(bad.status).toBe(422);

    const ok = (await property.action({
      request: req("/v1/manage/property", ak, "PATCH", {
        emails: { from_name: "Casa Test", reply_to: "Front@CasaTest.example", notify_host_on_cancel: false },
      }),
    } as never)) as Response;
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { data: { emails: Record<string, unknown> } };
    expect(json.data.emails).toMatchObject({ from_name: "Casa Test", reply_to: "front@casatest.example", notify_host_on_cancel: false, notify_host_on_booking: true });

    // null clears back to defaults.
    await property.action({ request: req("/v1/manage/property", ak, "PATCH", { emails: { reply_to: null } }) } as never);
    const settings = JSON.parse(store.get("settings:p1")!);
    expect("emailReplyTo" in settings).toBe(false);
    expect(settings.emailFromName).toBe("Casa Test");
  });
});
