// Transient-failure detection and bounded retry for D1. Dependency-free on
// purpose: it is imported from the KV write hook in image-gc-store.server.ts,
// which config.server.ts imports, which d1.server.ts imports.

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
