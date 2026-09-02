import { describe, expect, it, vi } from "vitest";

// Property registry guards from the 2026-09-02 security pass: an id can't
// capture another hotel's slug, a deleted id can't be re-registered by a
// stranger, deletion revokes everything that grants access, and a key for a
// property that no longer exists stops authenticating.

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

function seed() {
  store.clear();
  store.set(
    "properties",
    JSON.stringify([
      { id: "439ec597-8caf-47be-b07d-663a9602c79c", name: "Spilman Hotel", owner: "owner@spilman.test", slug: "spilmanhotel" },
      { id: "hotel-code-77", name: "Legacy", owner: "legacy@example.com" },
    ]),
  );
}

describe("propertyIdError / addProperty", () => {
  it("refuses an id equal to another property's slug — ids match before slugs", async () => {
    seed();
    const { addProperty, propertyIdError, getProperties } = await import("./properties.server");
    expect(propertyIdError("spilmanhotel", await getProperties())).toMatch(/booking link/);
    expect(propertyIdError("SpilmanHotel", await getProperties())).toMatch(/booking link/);
    await expect(addProperty("spilmanhotel", "Evil", "attacker@example.com")).rejects.toThrow(/booking link/);
    // Registry untouched.
    expect(JSON.parse(store.get("properties")!)).toHaveLength(2);
  });

  it("refuses malformed and reserved ids", async () => {
    seed();
    const { propertyIdError, getProperties } = await import("./properties.server");
    const list = await getProperties();
    for (const bad of ["//evil.com", "a b", "x/y", "", "-lead", "admin", "Images"]) {
      expect(propertyIdError(bad, list)).not.toBeNull();
    }
    expect(propertyIdError("6f9a3c1e-0000-4000-8000-000000000000", list)).toBeNull();
    expect(propertyIdError("CHX_hotel-42", list)).toBeNull();
  });

  it("re-adding your own existing property is a no-op; a stranger is refused", async () => {
    seed();
    const { addProperty } = await import("./properties.server");
    const same = await addProperty("hotel-code-77", "Renamed?", "Legacy@Example.com");
    expect(same.name).toBe("Legacy");
    await expect(addProperty("hotel-code-77", "Mine now", "attacker@example.com")).rejects.toThrow(/another account/);
  });
});

describe("deletePropertyForGood", () => {
  it("revokes keys and webhooks, clears payment/live settings, tombstones the id", async () => {
    seed();
    const pid = "hotel-code-77";
    store.set(
      `settings:${pid}`,
      JSON.stringify({ stripeAccountId: "acct_1", stripeChargesEnabled: true, liveBooking: true, connectedSystem: "channex", currency: "GBP", hotelName: "x" }),
    );
    store.set(`viva_config:${pid}`, JSON.stringify({ merchantId: "m", apiKey: "k", clientId: "c", clientSecret: "s", sourceCode: "1", demo: true }));
    store.set(`webhooks:${pid}`, JSON.stringify([{ id: "w1", url: "https://h.example/x", secret: "whsec_a", events: [], createdAt: "" }]));
    const { issueApiKey, identifyApiKey } = await import("./api-auth.server");
    const { raw } = await issueApiKey(pid, { label: "t", mode: "live", scope: "manage" });
    const authed = new Request("http://localhost/v1/manage/property", { headers: { Authorization: `Bearer ${raw}` } });
    expect(await identifyApiKey(authed)).toMatchObject({ pid });

    const { deletePropertyForGood } = await import("./property-delete.server");
    await deletePropertyForGood(pid);

    // Gone from the registry, key dead, webhooks and Viva gone, money/live flags cleared, content kept.
    expect(JSON.parse(store.get("properties")!).map((p: { id: string }) => p.id)).not.toContain(pid);
    expect(((await identifyApiKey(authed)) as Response).status).toBe(401);
    expect(store.has(`webhooks:${pid}`)).toBe(false);
    expect(store.has(`viva_config:${pid}`)).toBe(false);
    const settings = JSON.parse(store.get(`settings:${pid}`)!);
    expect(settings).toEqual({ currency: "GBP", hotelName: "x" });
    expect(store.has(`property_tombstone:${pid}`)).toBe(true);

    // Only the previous owner can bring it back.
    const { addProperty } = await import("./properties.server");
    await expect(addProperty(pid, "Legacy", "attacker@example.com")).rejects.toThrow(/deleted by another account/);
    await expect(addProperty(pid, "Legacy", "legacy@example.com")).resolves.toMatchObject({ id: pid });
  });

  it("a key whose property vanished from the registry no longer authenticates", async () => {
    seed();
    const { issueApiKey, identifyApiKey } = await import("./api-auth.server");
    const { raw } = await issueApiKey("hotel-code-77", { label: "t", mode: "live", scope: "book" });
    store.set("properties", JSON.stringify([{ id: "other", name: "Other", owner: "o@example.com" }]));
    const res = await identifyApiKey(new Request("http://localhost/v1/rooms", { headers: { Authorization: `Bearer ${raw}` } }));
    expect((res as Response).status).toBe(401);
  });
});
