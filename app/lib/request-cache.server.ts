// Per-request KV read cache.
//
// Every loader plumbs auth and property resolution through the same handful of
// KV keys (user record, properties registry, per-property settings), so one
// navigation used to read the same key many times over — measured live: an
// admin menu click was 16 KV gets across 5 distinct keys, a guest funnel step
// 21 across 11. Each get is a network round trip in production, and they run
// sequentially through the auth chain, so the duplication was most of the
// page's TTFB.
//
// The cache lives for exactly one request (AsyncLocalStorage, entered in
// workers/app.ts), so it can never serve anything staler than the request's own
// first read — KV itself is eventually consistent across colos, so collapsing
// duplicate reads within a request adds no new staleness. Writes drop the key
// (see getConfigKV) so a read-after-write inside one action still sees the new
// value. Promises are cached, not values, so concurrent reads of one key
// collapse too.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<Map<string, Promise<string | null>>>();

/** Enter a fresh cache scope for one unit of work (a request, a cron run). */
export function runWithRequestCache<T>(fn: () => T): T {
  return als.run(new Map(), fn);
}

/** The active request's cache, or undefined outside runWithRequestCache —
 *  callers must treat "no cache" as "read through" so nothing breaks in
 *  contexts that never entered a scope (tests, one-off scripts). */
export function requestKvCache(): Map<string, Promise<string | null>> | undefined {
  return als.getStore();
}
