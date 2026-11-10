import { createCookieSessionStorage } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real session and token code, with only the secret, KV and the user
// directory faked. What is under test is that something signed for ONE purpose
// never verifies as another: the cookie library signs the value only (not the
// cookie's name), and a magic link has the same `payload.signature` shape as a
// cookie, so with a shared key each of these was interchangeable.
const SECRET = "test-secret-value";
const ADMIN = "owner@example.com";
const kv = new Map<string, string>();
vi.mock("./config.server", () => ({
  getConfig: () => ({ sessionSecret: SECRET, appUrl: "https://example.test", adminEmails: [], superadminEmails: [] }),
  getConfigKV: () => ({
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => void kv.set(k, v),
  }),
}));
vi.mock("./email.server", () => ({ sendEmail: async () => ({ sent: true }) }));
vi.mock("./users.server", () => ({
  getUser: async (email: string) => (email === ADMIN ? { email } : null),
  isSuperadmin: async (email: string) => email === ADMIN,
  upsertUser: async () => undefined,
  claimSuperadminIfUnclaimed: async () => undefined,
}));
vi.mock("./partners.server", () => ({
  getPartner: async () => null,
  partnerIdForAdminHost: async () => null,
  brandForUser: async () => null,
}));
vi.mock("./domains.server", () => ({ isOwnHost: () => true }));

const { createAdminSession, createGuestMagicToken, createMagicToken, getAdminEmail } = await import("./auth.server");
const { createGuestSession, getGuestSession } = await import("./guest-auth.server");
const { signingKey } = await import("./signing-keys.server");

/** The signed value out of a redirect's Set-Cookie, without its name. */
function signedValue(res: Response): string {
  const first = res.headers.get("Set-Cookie")!.split(";")[0];
  return first.slice(first.indexOf("=") + 1);
}
const adminRequest = (value: string) =>
  new Request("https://example.test/admin", { headers: { Cookie: `__ibe_admin=${value}` } });
const guestRequest = (value: string) =>
  new Request("https://example.test/hotel-a/manage", { headers: { Cookie: `__ibe_guest2=${value}` } });

/** A magic token whose text is already a well-formed cookie value: the two
 *  differ only in base64url vs base64, i.e. only when a `-` or `_` appears. */
async function cookieShaped(mint: () => Promise<string>): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const token = await mint();
    if (!/[-_]/.test(token)) return token;
  }
  throw new Error("no cookie-shaped token in 200 tries");
}

beforeEach(() => kv.clear());

describe("a guest-portal session is not an admin session", () => {
  it("rejects a guest cookie presented under the admin cookie's name", async () => {
    // Anyone can get this cookie for any address: book under it, then enter the
    // portal with the reference.
    const guest = await createGuestSession({ email: ADMIN, pid: "hotel-a", only: "REF1" }, "/hotel-a/manage");
    expect(await getAdminEmail(adminRequest(signedValue(guest)))).toBeNull();
  });

  it("still accepts a real admin session", async () => {
    const admin = await createAdminSession(ADMIN, "/admin");
    expect(await getAdminEmail(adminRequest(signedValue(admin)))).toBe(ADMIN);
  });

  it("rejects an admin cookie presented as a guest cookie", async () => {
    const admin = await createAdminSession(ADMIN, "/admin");
    expect(await getGuestSession(guestRequest(signedValue(admin)), "hotel-a")).toBeNull();
  });

  it("requires the marker only createAdminSession writes, even under the admin key", async () => {
    // Belt to the key separation's braces: a correctly-signed value that was
    // not minted as an admin session must not read as "canonical host".
    const storage = createCookieSessionStorage({
      cookie: { name: "__ibe_admin", secrets: [signingKey("admin-session")] },
    });
    const session = await storage.getSession();
    session.set("email", ADMIN);
    const value = (await storage.commitSession(session)).split(";")[0].split("=").slice(1).join("=");
    expect(await getAdminEmail(adminRequest(value))).toBeNull();
  });
});

describe("a magic link is not a session", () => {
  // The link's expiry and single-use live in the verifier. Used as a cookie it
  // skipped both, so an old sign-in email was a permanent session.
  it("rejects an admin sign-in token presented as the admin cookie", async () => {
    const token = await cookieShaped(() => createMagicToken(ADMIN));
    expect(await getAdminEmail(adminRequest(token))).toBeNull();
  });

  it("rejects a guest link presented as the guest cookie", async () => {
    const token = await cookieShaped(() => createGuestMagicToken(ADMIN, "hotel-a"));
    expect(await getGuestSession(guestRequest(token), "hotel-a")).toBeNull();
  });
});

describe("signing keys", () => {
  it("are distinct per purpose and none is the raw secret", () => {
    const keys = [signingKey("admin-session"), signingKey("guest-session"), signingKey("magic-link")];
    expect(new Set([...keys, SECRET]).size).toBe(4);
  });
});
