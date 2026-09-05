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

export function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

/**
 * A per-isolate "create the schema exactly once" latch. Call the returned
 * ensure() before touching the tables. `statements` builds the full CREATE
 * TABLE/INDEX set — executed as one batch (see above for why that is not a
 * style choice).
 */
export function schemaOnce(statements: (d: D1Database) => D1PreparedStatement[]): () => Promise<void> {
  // The PROMISE is latched, not a boolean set after the await. A boolean is
  // only "once" for callers that arrive after the first one has finished:
  // everything that races the first request into a cold isolate — and a
  // deploy makes every request that — got past the flag while it was still
  // false and sent the DDL batch again, so a burst of concurrent first calls
  // meant a burst of identical CREATE batches.
  let ready: Promise<void> | undefined;
  return () => {
    ready ??= (async () => {
      const d = db();
      await d.batch(statements(d));
    })().catch((error) => {
      // A failed create must not latch, or the isolate is stuck answering
      // "schema ready" for a schema that was never made. Clearing it lets the
      // next caller try again; this one still sees the error.
      ready = undefined;
      throw error;
    });
    return ready;
  };
}

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

/**
 * Is this a transient D1 failure — one where the same statement is expected to
 * succeed on a retry?
 *
 * Cloudflare recycles the instance backing a D1 database (moves, restarts,
 * code updates), and an in-flight query at that moment fails with
 * "D1_ERROR: Connection closed: this D1 DB instance is no longer active.
 * Reconnect or retry the request." — the message says outright what to do.
 * These are infrastructure errors, NOT rejected statements: a constraint
 * violation, a missing table or a syntax error will never appear here, because
 * this matches an allowlist of transport failures rather than excluding known
 * SQL errors.
 */
export function isTransientD1Error(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return [
    "no longer active",
    "connection closed",
    "network connection lost",
    "internal error",
    "storage caused object to be reset",
    "reset because its code was updated",
  ].some((fragment) => message.includes(fragment));
}

/**
 * Run a D1 operation, retrying it while it fails transiently (see
 * isTransientD1Error). Anything else — a constraint violation, a bad statement
 * — throws on the first attempt, untouched.
 *
 * `work` MUST be idempotent: a "connection closed" can arrive after the
 * statement committed, so a retry may re-apply it. Every caller here upserts by
 * primary key or reads, so re-applying is a no-op.
 */
export async function d1Retry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isTransientD1Error(error)) throw error;
      // Short, bounded backoff: the instance is being replaced, which takes
      // milliseconds, and Channex is waiting on this response.
      await new Promise((resolve) => setTimeout(resolve, attempt * 200));
    }
  }
}
