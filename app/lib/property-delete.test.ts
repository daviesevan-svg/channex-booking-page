import { describe, expect, it, vi } from "vitest";

// Deletion is a checklist, and a checklist's failure mode is an item nobody
// added. iyzico was added as a gateway and never added here, so a deleted
// property kept live merchant API keys in KV. This asserts the whole list runs.
const calls: string[] = [];
vi.mock("./api-auth.server", () => ({
  revokeAllApiKeys: async (id: string) => void calls.push(`revokeAllApiKeys:${id}`),
}));
vi.mock("./webhooks.server", () => ({
  deleteAllWebhooks: async (id: string) => void calls.push(`deleteAllWebhooks:${id}`),
}));
vi.mock("./properties.server", () => ({
  removeProperty: async (id: string) => void calls.push(`removeProperty:${id}`),
}));
vi.mock("./overrides.server", () => ({
  saveVivaConfig: async (id: string, c: unknown) => void calls.push(`viva:${id}:${c}`),
  saveIyzicoConfig: async (id: string, c: unknown) => void calls.push(`iyzico:${id}:${c}`),
  clearSettingsFields: async (id: string, f: string[]) => void calls.push(`settings:${id}:${f.join(",")}`),
}));

const { deletePropertyForGood } = await import("./property-delete.server");

describe("deletePropertyForGood", () => {
  it("clears every gateway that keeps credentials in its own key", async () => {
    calls.length = 0;
    await deletePropertyForGood("p1");
    // Viva and iyzico each store outside `settings`, so clearSettingsFields
    // cannot reach them and each needs its own call.
    expect(calls).toContain("viva:p1:null");
    expect(calls).toContain("iyzico:p1:null");
  });

  it("clears Stripe and the live-traffic switches from settings", async () => {
    calls.length = 0;
    await deletePropertyForGood("p1");
    const settings = calls.find((c) => c.startsWith("settings:"))!;
    for (const field of ["stripeAccountId", "stripeChargesEnabled", "liveBooking", "connectedSystem"]) {
      expect(settings).toContain(field);
    }
  });

  it("revokes access before dropping the registry row", async () => {
    calls.length = 0;
    await deletePropertyForGood("p1");
    // Order matters: the row is the tombstone. Removing it first would leave a
    // window where the id is reclaimable and the credentials are still live.
    expect(calls.indexOf("removeProperty:p1")).toBe(calls.length - 1);
    expect(calls.indexOf("revokeAllApiKeys:p1")).toBeLessThan(calls.indexOf("removeProperty:p1"));
    expect(calls.indexOf("deleteAllWebhooks:p1")).toBeLessThan(calls.indexOf("removeProperty:p1"));
  });
});
