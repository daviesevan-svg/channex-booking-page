import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Google Ads ↔ Hotel Center links: one link per Ads customer, extended with a
// hotel list rather than duplicated, deleted only when the last hotel leaves.

const { store, kv } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  return { store, kv };
});
vi.mock("cloudflare:workers", () => ({ env: { CONFIG_KV: kv }, waitUntil: () => {} }));
vi.mock("../properties.server", () => ({ getProperties: async () => [{ id: "h1" }, { id: "h2" }] }));
vi.mock("../config.server", () => ({
  getConfig: () => ({
    googleTravelPartnerAccountId: "1234",
    googleTravelPartnerSaEmail: "sa@example.iam.gserviceaccount.com",
    googleTravelPartnerSaKey: "-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----",
  }),
  getConfigKV: () => kv,
}));
const matchState = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("./status.server", () => ({
  TRAVEL_PARTNER_API: "https://travelpartner.googleapis.com/v3",
  getAccessToken: async () => "tok",
  // The cached Google match status the link gate reads; null = never checked.
  readCachedMatchStatus: async () =>
    matchState.current ? { status: { state: matchState.current }, checkedAt: 1 } : null,
}));
// Settings live in KV too — a tiny in-memory stand-in with the real semantics.
vi.mock("../overrides.server", () => {
  const settings = new Map<string, Record<string, unknown>>();
  return {
    getSettings: async (pid: string) => ({ ...(settings.get(pid) ?? {}) }),
    patchSettings: async (pid: string, partial: Record<string, unknown>) => {
      const next = { ...(settings.get(pid) ?? {}) };
      for (const [k, v] of Object.entries(partial)) if (v !== undefined) next[k] = v;
      settings.set(pid, next);
      return next;
    },
    clearSettingsFields: async (pid: string, keys: string[]) => {
      const next = { ...(settings.get(pid) ?? {}) };
      for (const k of keys) delete next[k];
      settings.set(pid, next);
    },
    __settings: settings,
  };
});

import { formatGoogleAdsCustomerId, linkStateOf, normalizeGoogleAdsCustomerId } from "./account-link";
import { linkGoogleAds, refreshGoogleAdsLink, refreshPendingGoogleAdsLinks, unlinkGoogleAds } from "./account-link.server";
import * as overrides from "../overrides.server";

const settings = (overrides as unknown as { __settings: Map<string, Record<string, unknown>> }).__settings;

type Call = { method: string; url: string; body?: unknown };
let calls: Call[] = [];
/** Scripted Google: each handler decides by method + path. */
let google: (c: Call) => { status: number; body?: unknown };

beforeEach(() => {
  store.clear();
  settings.clear();
  matchState.current = null;
  calls = [];
  google = () => ({ status: 500, body: { error: { message: "unscripted" } } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const c: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      const r = google(c);
      return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const LINK = "accounts/1234/accountLinks/77";

describe("customer id helpers", () => {
  it("normalises the dashed display form to ten digits, rejects anything else", () => {
    expect(normalizeGoogleAdsCustomerId("278-353-0096")).toBe("2783530096");
    expect(normalizeGoogleAdsCustomerId(" 278 353 0096 ")).toBe("2783530096");
    expect(normalizeGoogleAdsCustomerId("2783530096")).toBe("2783530096");
    expect(normalizeGoogleAdsCustomerId("278-353-009")).toBeNull();
    expect(normalizeGoogleAdsCustomerId("customers/2783530096")).toBeNull();
    expect(normalizeGoogleAdsCustomerId(null)).toBeNull();
    expect(formatGoogleAdsCustomerId("2783530096")).toBe("278-353-0096");
  });
  it("maps Google's statuses onto UI states", () => {
    expect(linkStateOf("APPROVED")).toBe("approved");
    expect(linkStateOf("REQUESTED_FROM_HOTEL_CENTER")).toBe("pending_ads");
    expect(linkStateOf("REQUESTED_FROM_GOOGLE_ADS")).toBe("pending_hotel_center");
    expect(linkStateOf("SOMETHING_NEW")).toBe("unknown");
  });
});

describe("linkGoogleAds", () => {
  it("creates a link scoped to this hotel id and remembers it", async () => {
    google = (c) =>
      c.method === "POST"
        ? { status: 200, body: { name: LINK, status: "REQUESTED_FROM_HOTEL_CENTER" } }
        : { status: 404 };
    const res = await linkGoogleAds("h1", "278-353-0096");
    expect(res).toMatchObject({ ok: true, link: { customerId: "2783530096", name: LINK, status: "REQUESTED_FROM_HOTEL_CENTER" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://travelpartner.googleapis.com/v3/accounts/1234/accountLinks");
    expect(calls[0].body).toEqual({
      googleAdsCustomerName: "customers/2783530096",
      accountLinkTarget: { hotelList: { partnerHotelIds: ["h1"] } },
    });
    expect(settings.get("h1")?.googleAdsLink).toMatchObject({ name: LINK });
    expect(store.get("google:adslink:2783530096")).toBe(LINK);
  });

  it("rejects a malformed id without calling Google", async () => {
    const res = await linkGoogleAds("h1", "12345");
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a second property of the same customer joins the existing link (PATCH, not POST)", async () => {
    store.set("google:adslink:2783530096", LINK);
    settings.set("h1", { googleAdsLink: { customerId: "2783530096", name: LINK, status: "APPROVED", createdAt: 1, checkedAt: 1 } });
    google = (c) => {
      if (c.method === "GET") return { status: 200, body: { name: LINK, status: "APPROVED", accountLinkTarget: { hotelList: { partnerHotelIds: ["h1"] } } } };
      if (c.method === "PATCH") return { status: 200, body: { name: LINK } };
      return { status: 500 };
    };
    const res = await linkGoogleAds("h2", "2783530096");
    expect(res).toMatchObject({ ok: true, link: { name: LINK, status: "APPROVED" } });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1].url).toContain(`/${LINK}?updateMask=accountLink.account_link_target`);
    expect(calls[1].body).toEqual({ accountLinkTarget: { hotelList: { partnerHotelIds: ["h1", "h2"] } } });
  });

  it("a stale registry entry (link gone on Google) falls back to creating afresh", async () => {
    store.set("google:adslink:2783530096", "accounts/1234/accountLinks/old");
    google = (c) => {
      if (c.method === "GET") return { status: 404, body: { error: { status: "NOT_FOUND", message: "gone" } } };
      if (c.method === "POST") return { status: 200, body: { name: LINK, status: "REQUESTED_FROM_HOTEL_CENTER" } };
      return { status: 500 };
    };
    const res = await linkGoogleAds("h1", "2783530096");
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(store.get("google:adslink:2783530096")).toBe(LINK);
  });

  it("surfaces Google's message, with a permissions hint on 403", async () => {
    google = () => ({ status: 403, body: { error: { status: "PERMISSION_DENIED", message: "The caller does not have permission" } } });
    const res = await linkGoogleAds("h1", "2783530096");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Owner permission");
      expect(res.error).toContain("The caller does not have permission");
    }
    expect(settings.get("h1")?.googleAdsLink).toBeUndefined();
  });

  it("refuses a property Google hasn't matched, without calling Google", async () => {
    for (const state of ["not_found", "not_matched", "overlap"]) {
      matchState.current = state;
      const res = await linkGoogleAds("h1", "2783530096");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/hasn't matched/);
    }
    expect(calls).toHaveLength(0);
    expect(settings.get("h1")?.googleAdsLink).toBeUndefined();
  });

  it("links a matched property, and one whose status was never checked (fail-open)", async () => {
    google = (c) => (c.method === "POST" ? { status: 200, body: { name: LINK, status: "REQUESTED_FROM_HOTEL_CENTER" } } : { status: 404 });
    matchState.current = "matched";
    expect((await linkGoogleAds("h1", "2783530096")).ok).toBe(true);
    matchState.current = null;
    expect((await linkGoogleAds("h2", "1112223334")).ok).toBe(true);
    matchState.current = "unknown";
    settings.delete("h2");
    expect((await linkGoogleAds("h2", "1112223334")).ok).toBe(true);
  });

  it("refuses when the property is already linked", async () => {
    settings.set("h1", { googleAdsLink: { customerId: "1", name: LINK, status: "APPROVED", createdAt: 1, checkedAt: 1 } });
    const res = await linkGoogleAds("h1", "2783530096");
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("refreshGoogleAdsLink", () => {
  const linked = { customerId: "2783530096", name: LINK, status: "REQUESTED_FROM_HOTEL_CENTER", createdAt: 1, checkedAt: 1 };

  it("stores the status Google reports now", async () => {
    settings.set("h1", { googleAdsLink: linked });
    google = () => ({ status: 200, body: { name: LINK, status: "APPROVED", accountLinkTarget: { hotelList: { partnerHotelIds: ["h1"] } } } });
    const res = await refreshGoogleAdsLink("h1");
    expect(res).toMatchObject({ ok: true, link: { status: "APPROVED" } });
    expect((settings.get("h1")?.googleAdsLink as { checkedAt: number }).checkedAt).toBeGreaterThan(1);
  });

  it("clears our record when Google no longer has the link", async () => {
    settings.set("h1", { googleAdsLink: linked });
    store.set("google:adslink:2783530096", LINK);
    google = () => ({ status: 404, body: { error: { status: "NOT_FOUND" } } });
    const res = await refreshGoogleAdsLink("h1");
    expect(res).toEqual({ ok: true, link: null, removed: true });
    expect(settings.get("h1")?.googleAdsLink).toBeUndefined();
    expect(store.has("google:adslink:2783530096")).toBe(false);
  });

  it("clears our record when this hotel was dropped from the list", async () => {
    settings.set("h1", { googleAdsLink: linked });
    google = () => ({ status: 200, body: { name: LINK, status: "APPROVED", accountLinkTarget: { hotelList: { partnerHotelIds: ["h2"] } } } });
    const res = await refreshGoogleAdsLink("h1");
    expect(res).toEqual({ ok: true, link: null, removed: true });
  });

  it("keeps the old record on a transient error", async () => {
    settings.set("h1", { googleAdsLink: linked });
    google = () => ({ status: 503, body: { error: { status: "UNAVAILABLE", message: "try later" } } });
    const res = await refreshGoogleAdsLink("h1");
    expect(res.ok).toBe(false);
    expect(settings.get("h1")?.googleAdsLink).toEqual(linked);
  });
});

describe("unlinkGoogleAds", () => {
  const rec = (hotel: string) => ({ customerId: "2783530096", name: LINK, status: "APPROVED", createdAt: 1, checkedAt: 1, hotel });

  it("PATCHes this hotel off a shared link and keeps the registry", async () => {
    settings.set("h1", { googleAdsLink: rec("h1") });
    store.set("google:adslink:2783530096", LINK);
    google = (c) => {
      if (c.method === "GET") return { status: 200, body: { name: LINK, accountLinkTarget: { hotelList: { partnerHotelIds: ["h1", "h2"] } } } };
      if (c.method === "PATCH") return { status: 200, body: { name: LINK } };
      return { status: 500 };
    };
    expect(await unlinkGoogleAds("h1")).toEqual({ ok: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1].body).toEqual({ accountLinkTarget: { hotelList: { partnerHotelIds: ["h2"] } } });
    expect(settings.get("h1")?.googleAdsLink).toBeUndefined();
    expect(store.get("google:adslink:2783530096")).toBe(LINK);
  });

  it("DELETEs the link when this was the last hotel on it", async () => {
    settings.set("h1", { googleAdsLink: rec("h1") });
    store.set("google:adslink:2783530096", LINK);
    google = (c) => {
      if (c.method === "GET") return { status: 200, body: { name: LINK, accountLinkTarget: { hotelList: { partnerHotelIds: ["h1"] } } } };
      if (c.method === "DELETE") return { status: 200, body: {} };
      return { status: 500 };
    };
    expect(await unlinkGoogleAds("h1")).toEqual({ ok: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(store.has("google:adslink:2783530096")).toBe(false);
    expect(settings.get("h1")?.googleAdsLink).toBeUndefined();
  });

  it("a link already gone on Google just clears our side", async () => {
    settings.set("h1", { googleAdsLink: rec("h1") });
    google = () => ({ status: 404, body: {} });
    expect(await unlinkGoogleAds("h1")).toEqual({ ok: true });
    expect(settings.get("h1")?.googleAdsLink).toBeUndefined();
  });

  it("leaves our record in place when Google errors", async () => {
    settings.set("h1", { googleAdsLink: rec("h1") });
    google = () => ({ status: 500, body: { error: { message: "boom" } } });
    const res = await unlinkGoogleAds("h1");
    expect(res.ok).toBe(false);
    expect(settings.get("h1")?.googleAdsLink).toBeDefined();
  });
});

describe("refreshPendingGoogleAdsLinks (cron)", () => {
  it("re-checks pending links every run and approved ones only once a day", async () => {
    const now = Date.now();
    settings.set("h1", { googleAdsLink: { customerId: "1", name: "accounts/1234/accountLinks/1", status: "REQUESTED_FROM_HOTEL_CENTER", createdAt: 1, checkedAt: now - 2 * 3600e3 } });
    settings.set("h2", { googleAdsLink: { customerId: "2", name: "accounts/1234/accountLinks/2", status: "APPROVED", createdAt: 1, checkedAt: now - 2 * 3600e3 } });
    google = (c) => ({ status: 200, body: { name: c.url.split("/v3/")[1], status: "APPROVED", accountLinkTarget: { hotelList: { partnerHotelIds: ["h1", "h2"] } } } });
    await refreshPendingGoogleAdsLinks();
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["1"]);
    expect((settings.get("h1")?.googleAdsLink as { status: string }).status).toBe("APPROVED");
  });
});
