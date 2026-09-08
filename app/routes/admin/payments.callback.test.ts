import { describe, expect, it, vi } from "vitest";

// The Stripe Connect callback's partner-host hop. Stripe only redirects to the
// canonical host (APP_URL); an admin signed in on a partner's admin domain has
// their session — and the one-time nonce — there. Pins: a state carrying a
// REGISTERED partner admin origin is forwarded untouched (code + bare nonce)
// before any session check; an unknown origin is not, and falls through to the
// ordinary session-gated path; a bare nonce is handled locally as before.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

vi.mock("cloudflare:workers", () => ({
  env: { CONFIG_KV: kv, APP_URL: "https://book.roompanda.com" },
  waitUntil: () => {},
}));

const CANONICAL = "https://book.roompanda.com/admin/payments/callback";
const PARTNER = "https://admin.zimrly.com";
store.set("partner-admin-host:admin.zimrly.com", "zimrly");

async function callback(query: string) {
  const { loader } = await import("./payments.callback");
  const request = new Request(`${CANONICAL}?${query}`);
  try {
    return (await loader({ request, params: {}, context: {} } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

describe("Stripe Connect callback on the canonical host", () => {
  it("forwards a registered partner admin origin its code and the bare nonce, before any session check", async () => {
    const { encodeConnectState, generateConnectNonce } = await import("~/lib/stripe-connect-state");
    const nonce = generateConnectNonce();
    const res = await callback(`code=ac_test_123&state=${encodeURIComponent(encodeConnectState(nonce, PARTNER))}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe(PARTNER);
    expect(location.pathname).toBe("/admin/payments/callback");
    expect(location.searchParams.get("code")).toBe("ac_test_123");
    expect(location.searchParams.get("state")).toBe(nonce);
    expect(location.searchParams.get("error")).toBeNull();
  });

  it("forwards a denial too, so the partner host burns its nonce", async () => {
    const { encodeConnectState, generateConnectNonce } = await import("~/lib/stripe-connect-state");
    const nonce = generateConnectNonce();
    const res = await callback(
      `error=access_denied&error_description=The+user+denied&state=${encodeURIComponent(encodeConnectState(nonce, PARTNER))}`,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe(PARTNER);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toBe("The user denied");
    expect(location.searchParams.get("state")).toBe(nonce);
  });

  it("does not forward to a host that serves no admin of ours", async () => {
    const { encodeConnectState, generateConnectNonce } = await import("~/lib/stripe-connect-state");
    const res = await callback(
      `code=ac_test_123&state=${encodeURIComponent(encodeConnectState(generateConnectNonce(), "https://evil.example"))}`,
    );
    // No session on this request: the ordinary path sends the visitor to log
    // in on THIS host. The one thing that must not happen is a hop to evil.example.
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("evil.example");
    expect(location).not.toContain("ac_test_123");
  });

  it("handles a bare nonce locally (own-host flow unchanged)", async () => {
    const { generateConnectNonce } = await import("~/lib/stripe-connect-state");
    const res = await callback(`code=ac_test_123&state=${generateConnectNonce()}`);
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain(PARTNER);
    expect(location).not.toContain("ac_test_123");
  });
});
