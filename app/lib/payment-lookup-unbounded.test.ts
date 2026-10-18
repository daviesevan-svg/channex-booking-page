import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.server", () => ({ getConfig: () => ({ stripeSecretKey: "sk_test_x" }) }));

import { retrieveCheckoutSession } from "./stripe.server";
import { retrieveVivaTransaction, type VivaConfig } from "./viva.server";

afterEach(() => vi.unstubAllGlobals());

// A timeout on the lookup that decides "has this guest paid" reads as "not paid"
// (viva.return.tsx sends them back to an empty checkout), so these two must not
// carry an abort signal.
describe("payment verification lookups", () => {
  it("retrieveCheckoutSession sends no abort signal", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "cs_1" })));
    vi.stubGlobal("fetch", fetchMock);
    await retrieveCheckoutSession("acct_1", "cs_1");
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeUndefined();
  });

  it("retrieveVivaTransaction and its token exchange send no abort signal", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(String(url).includes("/connect/token") ? JSON.stringify({ access_token: "t" }) : "{}"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const v = { demo: true, clientId: "c", clientSecret: "s", merchantId: "m", isv: false } as unknown as VivaConfig;
    await retrieveVivaTransaction(v, "tx-1").catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect((call as unknown as [string, RequestInit])[1].signal).toBeUndefined();
    }
  });
});
