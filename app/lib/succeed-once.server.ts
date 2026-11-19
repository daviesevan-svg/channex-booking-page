// "Do this setup until it has worked once in this isolate" — without sharing an
// in-flight promise between requests.
//
// The schema latches used to cache the PROMISE for the whole isolate, so every
// request awaited whichever request happened to start the setup first. Workers
// does not allow that: a promise belongs to the request that created it, and
// when that request ends first (the browser cancels a hover prefetch, the
// 30-second request deadline answers, a cron run finishes) the runtime cancels
// its pending work. Every later request that awaits the latched promise then
// fails with "This promise was created by a request that has since ended, so it
// can never settle" — and because a cancelled promise never REJECTS, the latch
// was never cleared, so the isolate failed every caller until it was recycled.
// (Before the runtime reported it, the same thing was a silent hang: the
// 2026-09-07 outage.)
//
// So only the fact of success is isolate-wide. An attempt in flight is shared
// with concurrent callers in the SAME request (keyed by the request's scope from
// request-cache.server.ts) and never with another request. The cost: on a cold
// isolate, requests arriving together each run the setup once. Every user of
// this runs idempotent `CREATE … IF NOT EXISTS` DDL, so that's a few redundant
// milliseconds, not a correctness problem.
//
// A leaf module on purpose (it imports only request-cache.server, itself a
// leaf), so the image-GC store can use it without the d1.server ->
// config.server -> image-gc-store import cycle.
import { requestKvCache } from "./request-cache.server";

export function succeedOnce(work: () => Promise<void>): () => Promise<void> {
  let done = false;
  const inFlight = new WeakMap<object, Promise<void>>();
  return () => {
    if (done) return Promise.resolve();
    const scope = requestKvCache();
    const shared = scope ? inFlight.get(scope) : undefined;
    if (shared) return shared;
    const attempt = work().then(() => {
      done = true;
    });
    if (scope) {
      inFlight.set(scope, attempt);
      // A failure must not stick to the request either: the next call retries.
      attempt.catch(() => inFlight.delete(scope));
    }
    return attempt;
  };
}
