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
      // Bounded, because a latched promise that never settles wedges the whole
      // isolate: every later caller awaits the same pending batch, nothing is
      // ever logged (no request completes), and the isolate stays warm on the
      // very traffic that is hanging. That is what took every ARI-reading
      // guest page down on 2026-09-07 while D1 itself answered in under a
      // millisecond — one lost response to the DDL batch, latched for the
      // lifetime of the isolate. A rejection clears the latch (below); a hang
      // never reached that code, so it is turned into one here.
      await withTimeout(d.batch(statements(d)), SCHEMA_TIMEOUT_MS, "D1 schema batch");
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
