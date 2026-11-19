import { describe, expect, it, vi } from "vitest";

import { runWithRequestCache } from "./request-cache.server";
import { succeedOnce } from "./succeed-once.server";

// Each runWithRequestCache scope stands in for one Worker request.
const inRequest = <T>(fn: () => T) => runWithRequestCache(fn);
const never = () => new Promise<void>(() => {});

describe("succeedOnce", () => {
  it("never makes one request wait on another request's attempt", async () => {
    // The production failure: request A starts the setup and ends before it
    // settles, so the runtime cancels A's promise and it never settles. Request B
    // must run its own attempt, not await A's.
    const work = vi.fn().mockImplementationOnce(never).mockResolvedValue(undefined);
    const ensure = succeedOnce(work);
    void inRequest(() => ensure()); // A: pending forever
    await expect(inRequest(() => ensure())).resolves.toBeUndefined(); // B
    expect(work).toHaveBeenCalledTimes(2);
    // B's success is remembered isolate-wide; nobody else runs the setup.
    await inRequest(() => ensure());
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("shares one attempt between concurrent calls in the same request", async () => {
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const ensure = succeedOnce(work);
    const both = inRequest(() => {
      const a = ensure();
      const b = ensure();
      finish();
      return Promise.all([a, b]);
    });
    await both;
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failure, in the same request or another", async () => {
    const work = vi.fn().mockRejectedValueOnce(new Error("D1 down")).mockResolvedValue(undefined);
    const ensure = succeedOnce(work);
    await inRequest(async () => {
      await expect(ensure()).rejects.toThrow("D1 down");
      await expect(ensure()).resolves.toBeUndefined(); // retried, same request
    });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("works outside any request scope (cron, tests) without sharing", async () => {
    const work = vi.fn().mockResolvedValue(undefined);
    const ensure = succeedOnce(work);
    await Promise.all([ensure(), ensure()]);
    expect(work).toHaveBeenCalledTimes(2); // no scope = no sharing, both run
    await ensure();
    expect(work).toHaveBeenCalledTimes(2); // then remembered
  });
});
