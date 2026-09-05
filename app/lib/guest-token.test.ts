import { beforeEach, describe, expect, it, vi } from "vitest";

// The real token functions, with only the secret and KV faked. Testing the
// audience rule in isolation is not enough: create and verify have to agree on
// a wire format, and the pid has to survive the round trip — a link mailed for
// one hotel must not open another's portal on the shared host.
const kv = new Map<string, string>();
vi.mock("./config.server", () => ({
  getConfig: () => ({ sessionSecret: "test-secret-value", appUrl: "https://example.test" }),
  getConfigKV: () => ({
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => void kv.set(k, v),
  }),
}));
vi.mock("./email.server", () => ({ sendEmail: async () => ({ sent: true }) }));
vi.mock("./users.server", () => ({}));
vi.mock("./partners.server", () => ({}));
vi.mock("./domains.server", () => ({}));

const {
  createGuestMagicToken,
  createMagicToken,
  verifyGuestMagicToken,
  verifyMagicToken,
} = await import("./auth.server");

beforeEach(() => kv.clear());

describe("guest magic tokens", () => {
  it("round-trips the email and the property", async () => {
    const token = await createGuestMagicToken("Guest@Example.com", "hotel-a");
    expect(await verifyGuestMagicToken(token)).toEqual({
      email: "guest@example.com",
      pid: "hotel-a",
    });
  });

  it("is single-use", async () => {
    const token = await createGuestMagicToken("guest@example.com", "hotel-a");
    expect(await verifyGuestMagicToken(token)).not.toBeNull();
    expect(await verifyGuestMagicToken(token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await createGuestMagicToken("guest@example.com", "hotel-a");
    const [payload, sig] = token.split(".");
    const forged = btoa(JSON.stringify({ email: "victim@example.com", pid: "hotel-a", aud: "guest", exp: Date.now() + 60000, jti: "x" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyGuestMagicToken(`${forged}.${sig}`)).toBeNull();
    expect(payload).not.toBe(forged);
  });

  it("does not open the admin door", async () => {
    const token = await createGuestMagicToken("admin@example.com", "hotel-a");
    expect(await verifyMagicToken(token)).toBeNull();
  });

  it("and an admin link does not open the guest portal", async () => {
    const token = await createMagicToken("admin@example.com");
    expect(await verifyGuestMagicToken(token)).toBeNull();
  });

  it("rejects junk instead of throwing", async () => {
    for (const t of ["", "nonsense", "a.b", "a.b.c"]) {
      expect(await verifyGuestMagicToken(t)).toBeNull();
    }
  });
});
