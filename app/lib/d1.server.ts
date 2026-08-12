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
  let ready = false;
  return async () => {
    if (ready) return;
    const d = db();
    await d.batch(statements(d));
    ready = true;
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
