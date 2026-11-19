// Shared D1 scaffolding: the guarded binding accessor, the per-isolate
// schema-creation latch, and the keep-alive-past-the-response wrapper.
//
// Extracted from seven hand-copies (the three analytics modules, bookings,
// vouchers, reviews, and two more waitUntil call sites) that had already
// drifted where it mattered: bookings created its table and its UNIQUE
// booking_ref index with sequential .run() calls, so a failure between the two
// left the table live WITHOUT the finalize-once uniqueness guarantee while the
// latch stayed unset — a concurrent isolate in that window could insert a
// duplicate reference. schemaOnce takes the statements as ONE batch, so a
// partially applied schema can't be observed.
import { waitUntil } from "cloudflare:workers";

import { getDB } from "./config.server";
import { withTimeout } from "./io-timeout";
import { succeedOnce } from "./succeed-once.server";

export function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

/**
 * A per-isolate "create the schema once" latch. Call the returned ensure()
 * before touching the tables. `statements` builds the full CREATE TABLE/INDEX
 * set — executed as one batch (see above for why that is not a style choice).
 *
 * Only success is remembered isolate-wide; an attempt in flight is shared only
 * within one request (see succeed-once.server.ts for why sharing it across
 * requests failed every caller of an isolate with "This promise was created by
 * a request that has since ended").
 */
export function schemaOnce(statements: (d: D1Database) => D1PreparedStatement[]): () => Promise<void> {
  return succeedOnce(async () => {
    const d = db();
    // Bounded: a batch whose response is lost would otherwise hold this
    // request until the platform kills it (the 2026-09-07 outage was the
    // isolate-wide version of that).
    await withTimeout(d.batch(statements(d)), SCHEMA_TIMEOUT_MS, "D1 schema batch");
  });
}

/** Generous for DDL that is a no-op once the tables exist (sub-second), tight
 *  enough that a lost response costs one request an error, not the isolate. */
export const SCHEMA_TIMEOUT_MS = 10_000;

// withTimeout lives in io-timeout.ts (a leaf module shared with the KV and
// request-deadline bounds); re-exported unchanged for the schema latch's callers.
export { withTimeout };

/**
 * Keep `work` alive past the response without letting it delay or fail the
 * caller: waitUntil inside a request context, a floating promise outside one
 * (dev, cron bodies). The promise must carry its own .catch — this wrapper
 * deliberately doesn't swallow rejections.
 */
export function fireAndForget(work: Promise<unknown>): void {
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

// isTransientD1Error / d1Retry live in d1-retry.ts (a leaf module, so the
// image-GC KV hook can retry without importing this module and closing the
// d1.server -> config.server -> image-gc-store cycle). Re-exported unchanged.
export { d1Retry, isTransientD1Error } from "./d1-retry";
