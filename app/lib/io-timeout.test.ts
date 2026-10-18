import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  boundD1,
  boundD1ForRequest,
  boundedRead,
  D1_STATEMENT_TIMEOUT_MS,
  IoTimeoutError,
  KV_READ_TIMEOUT_MS,
  REQUEST_DEADLINE_MS,
  runWithIoTrace,
  withRequestDeadline,
} from "./io-timeout";
import { runWithRequestCache } from "./request-cache.server";

const never = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("boundedRead", () => {
  it("re-issues a read whose first attempt never answers", async () => {
    const read = vi.fn().mockImplementationOnce(never).mockResolvedValueOnce("v");
    const p = boundedRead("KV get k", read);
    await vi.advanceTimersByTimeAsync(KV_READ_TIMEOUT_MS);
    await expect(p).resolves.toBe("v");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("gives up with a labelled error once every attempt stalls", async () => {
    const read = vi.fn(never);
    const p = boundedRead("KV get settings:p1", read);
    const settled = expect(p).rejects.toThrow(/KV get settings:p1 did not respond within 4000 ms/);
    await vi.advanceTimersByTimeAsync(KV_READ_TIMEOUT_MS * 2);
    await settled;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not retry a read that was answered with an error", async () => {
    const read = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(boundedRead("KV get k", read)).rejects.toThrow("boom");
    expect(read).toHaveBeenCalledTimes(1);
  });
});

function fakeD1() {
  const calls: string[] = [];
  const stall = { on: false };
  const stmt = (sql: string): Record<string, unknown> => ({
    __real: true,
    bind: () => stmt(sql),
    first: () => {
      calls.push(`first ${sql}`);
      return stall.on ? never() : Promise.resolve({ ok: 1 });
    },
    run: () => {
      calls.push(`run ${sql}`);
      return stall.on ? never() : Promise.resolve({ success: true });
    },
  });
  const batchArgs: unknown[][] = [];
  const d1 = {
    prepare: (sql: string) => stmt(sql),
    batch: (s: unknown[]) => {
      batchArgs.push(s);
      return Promise.resolve([]);
    },
  };
  return { d1: d1 as unknown as D1Database, calls, stall, batchArgs };
}

describe("boundD1", () => {
  it("re-issues a SELECT that never answers", async () => {
    const { d1, calls, stall } = fakeD1();
    stall.on = true;
    const p = boundD1(d1).prepare("SELECT 1").bind().first();
    const settled = expect(p).rejects.toBeInstanceOf(IoTimeoutError);
    await vi.advanceTimersByTimeAsync(D1_STATEMENT_TIMEOUT_MS * 2);
    await settled;
    expect(calls).toEqual(["first SELECT 1", "first SELECT 1"]);
  });

  it("bounds a write but never repeats it", async () => {
    const { d1, calls, stall } = fakeD1();
    stall.on = true;
    const p = boundD1(d1).prepare("INSERT INTO t VALUES (1)").run();
    const settled = expect(p).rejects.toThrow(/D1 run "INSERT INTO t VALUES \(1\)" did not respond/);
    await vi.advanceTimersByTimeAsync(D1_STATEMENT_TIMEOUT_MS);
    await settled;
    expect(calls).toEqual(["run INSERT INTO t VALUES (1)"]);
  });

  it("hands batch() the statements D1 itself issued, not the proxies", async () => {
    const { d1, batchArgs } = fakeD1();
    const bound = boundD1(d1);
    await bound.batch([bound.prepare("CREATE TABLE a (x)"), bound.prepare("SELECT 1").bind()]);
    expect(batchArgs[0]).toHaveLength(2);
    for (const s of batchArgs[0]) expect((s as { __real?: boolean }).__real).toBe(true);
  });

  it("only bounds inside a request scope", () => {
    const { d1 } = fakeD1();
    expect(boundD1ForRequest(d1)).toBe(d1);
    runWithRequestCache(() => expect(boundD1ForRequest(d1)).not.toBe(d1));
  });
});

describe("withRequestDeadline", () => {
  const htmlAccept = { headers: { Accept: "text/html,application/xhtml+xml" } };
  const get = new Request("https://book.roompanda.com/admin", htmlAccept);

  it("answers a browser GET that never produces a response with a retryable HTML 503", async () => {
    const p = withRequestDeadline(get, never());
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
    const res = await p;
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("This page took too long to load. Please try again.");
    expect(body).toContain('href="/admin"');
    expect(body).toContain("Admin home");
  });

  it("keeps API, feed, image, and single-fetch responses as plain text", async () => {
    const urls = [
      "https://book.roompanda.com/admin/inventory.data?start=1",
      "https://book.roompanda.com/v1/bookings",
      "https://book.roompanda.com/feeds/google-hotels.xml",
      "https://book.roompanda.com/images/photo.jpg",
      "https://book.roompanda.com/admin",
    ];
    for (const url of urls) {
      const req = new Request(url, url.endsWith("/admin") ? undefined : { headers: { Accept: "text/html" } });
      const p = withRequestDeadline(req, never());
      await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
      const res = await p;
      expect(res.headers.get("Content-Type"), url).toContain("text/plain");
      expect(await res.text()).toBe("This page took too long to load. Please try again.");
    }
  });

  it("escapes the retry link on an HTML document", async () => {
    const guest = new Request("https://book.roompanda.com/rooms?x=<script>&y=1", htmlAccept);
    const gp = withRequestDeadline(guest, never());
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
    const html = await (await gp).text();
    // The URL parser percent-encodes the query before it reaches the page, and
    // the attribute is escaped again, so a crafted query cannot break out.
    expect(html).toContain('href="/rooms?x=%3Cscript%3E&amp;y=1"');
    expect(html).toContain('href="/"');
    expect(html).not.toContain("<script>");
  });

  it("passes a prompt response straight through", async () => {
    const ok = new Response("hi");
    await expect(withRequestDeadline(get, Promise.resolve(ok))).resolves.toBe(ok);
  });

  it("leaves a POST alone — a long checkout or import is not a hang", async () => {
    const post = new Request("https://book.roompanda.com/admin/x", { method: "POST" });
    const slow = new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("done")), REQUEST_DEADLINE_MS * 2));
    const p = withRequestDeadline(post, slow);
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS * 2);
    expect((await p).status).toBe(200);
  });
});

describe("the deadline log names what the request was doing", () => {
  const get = new Request("https://bookonline.roxiehub.net/artemis-hotel-evia");
  const logged = () => (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join("\n");

  it("lists a KV read that is still pending and the ones that finished first", async () => {
    await runWithIoTrace(async () => {
      await boundedRead("KV get partner-guest-host:x", () => Promise.resolve("v"));
      void boundedRead("KV get settings:p1", never).catch(() => {});
      const p = withRequestDeadline(get, never());
      await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
      await p;
    });
    const line = logged();
    expect(line).toMatch(/\[request-deadline\] GET https:\/\/bookonline\.roxiehub\.net\/artemis-hotel-evia/);
    expect(line).toMatch(/last settled: KV get partner-guest-host:x ok/);
    expect(line).toMatch(/KV get settings:p1 .*TIMEOUT/);
  });

  it("says plainly when nothing was in flight, so the stall is not a storage call", async () => {
    await runWithIoTrace(async () => {
      await boundedRead("KV get k", () => Promise.resolve("v"));
      const p = withRequestDeadline(get, never());
      await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
      await p;
    });
    expect(logged()).toMatch(/in flight: NOTHING \(not a KV\/D1 stall\)/);
  });

  it("is a no-op outside a request scope (cron, scripts)", async () => {
    const p = withRequestDeadline(get, never());
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
    await p;
    expect(logged()).toMatch(/no io trace/);
  });
});
