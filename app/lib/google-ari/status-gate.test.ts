import { beforeEach, describe, expect, it, vi } from "vitest";

// The push gate asks Google whether a property is matched at most once an hour
// per property, whatever the answer — see gateMatchStatus.

// vi.mock factories are hoisted above imports, so the fake KV they close over
// has to be hoisted too.
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
vi.mock("../properties.server", () => ({ getProperties: async () => [] }));

import { gateMatchStatus, MATCH_GATE_MAX_AGE_MS, type GoogleMatchStatus } from "./status.server";

const matched: GoogleMatchStatus = { state: "matched", matched: true, liveOnGoogle: true, matchStatus: "MATCHED", reasons: [] };
const notMatched: GoogleMatchStatus = { state: "not_matched", matched: false, liveOnGoogle: false, matchStatus: "NOT_MATCHED", reasons: [] };

beforeEach(() => {
  store.clear();
  vi.useRealTimers();
});

describe("gateMatchStatus", () => {
  it("calls Google once, then answers from the cache for an hour", async () => {
    const live = vi.fn(async () => matched);
    for (let i = 0; i < 25; i++) expect(await gateMatchStatus("h1", live)).toEqual(matched);
    expect(live).toHaveBeenCalledTimes(1);
    // The success refreshed the shared cache the admin page reads.
    expect(JSON.parse(store.get("google:match:h1")!).status).toEqual(matched);
  });

  it("a failed check still spends the hour — no call per delivery on a Google hiccup", async () => {
    const live = vi.fn(async () => null);
    for (let i = 0; i < 10; i++) expect(await gateMatchStatus("h1", live)).toBeNull();
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("serves the last-known-good status while a fresh check fails", async () => {
    store.set("google:match:h1", JSON.stringify({ status: notMatched, checkedAt: Date.now() - MATCH_GATE_MAX_AGE_MS - 1 }));
    const live = vi.fn(async () => null);
    expect(await gateMatchStatus("h1", live)).toEqual(notMatched);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("checks again once the cached value is older than an hour", async () => {
    vi.useFakeTimers();
    const live = vi.fn(async () => matched);
    await gateMatchStatus("h1", live);
    vi.advanceTimersByTime(MATCH_GATE_MAX_AGE_MS + 1);
    // The attempt marker would have expired in KV by now; the fake store never
    // expires, so drop it the way KV would have.
    store.delete("google:match-attempt:h1");
    await gateMatchStatus("h1", live);
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("throttles per property, not globally", async () => {
    const live = vi.fn(async () => matched);
    await gateMatchStatus("h1", live);
    await gateMatchStatus("h2", live);
    await gateMatchStatus("h1", live);
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("survives a live check that throws", async () => {
    const live = vi.fn(async () => { throw new Error("boom"); });
    expect(await gateMatchStatus("h1", live)).toBeNull();
  });
});
