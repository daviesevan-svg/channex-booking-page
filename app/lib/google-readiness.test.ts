import { beforeEach, describe, expect, it, vi } from "vitest";

// Google must only advertise a property a guest can actually book. Any gateway
// checkout charges through counts (Stripe with charges enabled, Viva, iyzico,
// 2C2P), as does a live Channex connection. iyzico and 2C2P used to be missed,
// so a property paid through either alone was dropped from every Google feed
// and told to "connect Stripe".

let configs: { viva?: object; iyzico?: object; c2p?: object } = {};
let ari = false;

vi.mock("./config.server", () => ({ getConfig: () => ({ stripeSecretKey: "sk_test" }) }));
vi.mock("./overrides.server", () => ({
  getSettings: async () => ({}),
  getOverrides: async () => ({}),
  getVivaConfig: async () => configs.viva ?? null,
  getIyzicoConfig: async () => configs.iyzico ?? null,
  getC2pConfig: async () => configs.c2p ?? null,
}));
vi.mock("./properties.server", () => ({ getProperty: async () => undefined }));
vi.mock("./ari/ingest.server", () => ({ hasReceivedAri: async () => ari }));

const { canTakeBookings, requiredMissing } = await import("./google-readiness.server");

beforeEach(() => {
  configs = {};
  ari = false;
});

describe("canTakeBookings", () => {
  it.each([
    ["iyzico", { iyzico: { apiKey: "k", secretKey: "s" } }],
    ["2C2P", { c2p: { merchantId: "JT01", secretKey: "s" } }],
    ["Viva", { viva: { merchantId: "m" } }],
  ])("a property paid through %s alone can take bookings", async (_name, c) => {
    configs = c;
    expect(await canTakeBookings("p1", {})).toBe(true);
  });

  it("Stripe with charges enabled can", async () => {
    expect(await canTakeBookings("p1", { stripeAccountId: "acct_1", stripeChargesEnabled: true })).toBe(true);
  });

  it("a live Channex connection can", async () => {
    ari = true;
    expect(await canTakeBookings("p1", { connectedSystem: "channex" })).toBe(true);
  });

  it("no gateway and no live connection can't", async () => {
    expect(await canTakeBookings("p1", {})).toBe(false);
    // Connected but Channex has never sent rates: not trading yet.
    expect(await canTakeBookings("p1", { connectedSystem: "channex" })).toBe(false);
  });

  it("a Stripe account that can't charge yet can't, even with another gateway stored", async () => {
    // Checkout resolves Stripe first (activeGateway), so the guest would be
    // sent to an account that can't take the money.
    configs = { iyzico: { apiKey: "k", secretKey: "s" } };
    expect(await canTakeBookings("p1", { stripeAccountId: "acct_1", stripeChargesEnabled: false })).toBe(false);
  });
});

describe("requiredMissing", () => {
  it("names every gateway in the payment requirement", () => {
    const missing = requiredMissing({}, {}, false, true).find((m) => m.field === "payment");
    expect(missing?.label).toMatch(/Stripe, Viva, iyzico or 2C2P/);
  });
});
