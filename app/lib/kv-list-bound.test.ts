import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("cloudflare:workers", () => ({
  env: {
    CONFIG_KV: {
      list: (...args: unknown[]) => list(...args),
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  },
  waitUntil: () => {},
}));

import { getConfigKV } from "./config.server";
import { KV_READ_TIMEOUT_MS } from "./io-timeout";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  list.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getConfigKV().list", () => {
  it("re-issues a list that never answers, then fails naming the prefix", async () => {
    list.mockImplementation(() => new Promise(() => {}));
    const pending = getConfigKV().list({ prefix: "user:" });
    const settled = expect(pending).rejects.toThrow(/KV list user: did not respond within 4000 ms/);
    await vi.advanceTimersByTimeAsync(KV_READ_TIMEOUT_MS * 2);
    await settled;
    expect(list).toHaveBeenCalledTimes(2);
  });
});
