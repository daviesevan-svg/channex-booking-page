// Server half of web-checkout book-intent idempotency.
//
// Two latches, matching the two existing patterns:
//   1. KV `idem:web:${pid}:${hash}` — replay the outcome (API Idempotency-Key).
//   2. D1 `checkout_intent` — one reference per fingerprint (claimBooking /
//      claimWindow). Concurrent double-clicks share that reference so Stripe's
//      Idempotency-Key (the reference) and finalize-once both see one stay.
import { generateReference, getBookingByReference } from "./bookings.server";
import { getConfigKV, getDB } from "./config.server";
import { db, schemaOnce } from "./d1.server";
import { decideWebCheckoutReplay, type WebCheckoutCached } from "./checkout-idem";
import { getPending } from "./pending-bookings.server";

// Match pending-booking TTL: after this the Stripe session is long dead, and a
// later identical stay is a new booking, not a replay.
const TTL_SECONDS = 3 * 3600;
const TTL_MS = TTL_SECONDS * 1000;

// Keep an additional margin beyond the three-hour pending/replay lifetime.
// Permanent booking and refund claims live in other tables and are untouched.
export const CHECKOUT_INTENT_RETENTION_MS = 24 * 3600 * 1000;
const PRUNE_BATCH_SIZE = 1000;
const PRUNE_MAX_BATCHES = 5;

const idemKey = (pid: string, fingerprint: string) => `idem:web:${pid}:${fingerprint}`;

const ensureIntentSchema = schemaOnce((d) => [
  d.prepare(
    `CREATE TABLE IF NOT EXISTS checkout_intent (
        pid TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        reference TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (pid, fingerprint)
      )`,
  ),
]);

/** Bounded maintenance, with an indexed age predicate (see migrations/).
 * The cutoff is checked in the DELETE itself, so refreshing a fingerprint
 * before this statement runs cannot delete the new claim. */
export async function pruneCheckoutIntents(now = Date.now()): Promise<number> {
  if (!getDB()) return 0;
  await ensureIntentSchema();
  const cutoff = new Date(now - CHECKOUT_INTENT_RETENTION_MS).toISOString();
  let deleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const result = await db().prepare(
      `DELETE FROM checkout_intent WHERE created_at < ? AND rowid IN (
        SELECT rowid FROM checkout_intent WHERE created_at < ? ORDER BY created_at LIMIT ?
      )`,
    ).bind(cutoff, cutoff, PRUNE_BATCH_SIZE).run();
    const count = result.meta.changes ?? 0;
    deleted += count;
    if (count < PRUNE_BATCH_SIZE) break;
  }
  return deleted;
}

export async function readWebCheckoutIdem(
  pid: string,
  fingerprint: string,
): Promise<WebCheckoutCached | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(idemKey(pid, fingerprint));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WebCheckoutCached;
    if (parsed?.kind === "payment" && parsed.url && parsed.reference) return parsed;
    if (parsed?.kind === "confirmed" && parsed.reference) return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function writeWebCheckoutIdem(
  pid: string,
  fingerprint: string,
  value: WebCheckoutCached,
): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(idemKey(pid, fingerprint), JSON.stringify(value), { expirationTtl: TTL_SECONDS });
}

/** Atomically bind one booking reference to this fingerprint. A live row
 *  older than the pending TTL can be stolen (same UPDATE … WHERE created_at
 *  latch as claimWindow). Fails open without D1 — local/dev still books, but
 *  concurrent double-clicks are only de-duped when D1 is bound. */
export async function claimCheckoutReference(pid: string, fingerprint: string): Promise<string> {
  if (!getDB()) return generateReference();
  await ensureIntentSchema();
  const reference = generateReference();
  const now = new Date().toISOString();
  const inserted = await db()
    .prepare(
      `INSERT INTO checkout_intent (pid, fingerprint, reference, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(pid, fingerprint, reference, now)
    .run();
  if (inserted.meta.changes === 1) return reference;

  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  const stolen = await db()
    .prepare(
      `UPDATE checkout_intent SET reference = ?, created_at = ?
        WHERE pid = ? AND fingerprint = ? AND created_at < ?`,
    )
    .bind(reference, now, pid, fingerprint, cutoff)
    .run();
  if (stolen.meta.changes === 1) return reference;

  const row = await db()
    .prepare(`SELECT reference FROM checkout_intent WHERE pid = ? AND fingerprint = ?`)
    .bind(pid, fingerprint)
    .first<{ reference: string }>();
  if (row) return row.reference;
  // Maintenance may have removed an expired row between our conflicting
  // INSERT and the UPDATE/SELECT. Retry the claim rather than hand out an
  // unpersisted reference: concurrent submits must still share one reference.
  return claimCheckoutReference(pid, fingerprint);
}

/** Drop a failed attempt so the guest's next submit is a new intent, not a
 *  replay of a Stripe/Viva error bound to the same reference for 24h. */
export async function releaseCheckoutIntent(pid: string, fingerprint: string): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.delete(idemKey(pid, fingerprint));
  if (!getDB()) return;
  await ensureIntentSchema();
  await db()
    .prepare(`DELETE FROM checkout_intent WHERE pid = ? AND fingerprint = ?`)
    .bind(pid, fingerprint)
    .run();
}

/** Look up a prior submit of this stay. Redirect when one already produced a
 *  payment URL or a standing booking; otherwise return the (shared) reference
 *  so this request continues as that same stay. */
export async function resolveWebCheckoutIntent(
  pid: string,
  fingerprint: string,
  confirmUrl: (reference: string) => string,
): Promise<{ kind: "redirect"; url: string; document: boolean } | { kind: "continue"; reference: string }> {
  const cached = await readWebCheckoutIdem(pid, fingerprint);
  const firstRef = cached?.reference ?? (await claimCheckoutReference(pid, fingerprint));
  const booking = await getBookingByReference(pid, firstRef);
  const pending = await getPending(firstRef);
  const replay = decideWebCheckoutReplay({
    cached: cached ?? null,
    booking: booking
      ? { status: booking.status, lifecycle: booking.lifecycle, reference: booking.reference }
      : null,
    paymentUrl: pending?.paymentUrl ?? null,
  });
  // `document` marks a redirect the caller must send as a DOCUMENT navigation.
  // The confirmation page is one: a client-side redirect there has to discover
  // the route first, which fails outright in a tab whose build has been
  // deployed over (see the note at the redirectDocument call in checkout.tsx).
  // A payment URL is cross-origin, so it is a document navigation regardless.
  if (replay?.kind === "payment") return { kind: "redirect", url: replay.url, document: false };
  if (replay?.kind === "confirmed") return { kind: "redirect", url: confirmUrl(replay.reference), document: true };

  // Cancelled/failed (or a first submit): make sure we are not bound to a
  // dead reference. Releasing then claiming is a no-op when nothing was stored.
  if (booking && (booking.lifecycle === "cancelled" || booking.status === "failed")) {
    await releaseCheckoutIntent(pid, fingerprint);
    return { kind: "continue", reference: await claimCheckoutReference(pid, fingerprint) };
  }
  return { kind: "continue", reference: firstRef };
}
