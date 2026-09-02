// A once-only latch for money going back out.
//
// Neither refund path had one. Stripe refunds carried an idempotency key, so a
// double call was harmless there; Viva's refund API has no such thing, and the
// only fence was "read `payment.refund`, then write it" — two concurrent
// cancels (a guest double-submitting with auto-refund on, an operator
// double-clicking, the return URL racing the webhook on a rejected charge) both
// read "not refunded" and both called Viva. Same shape as `claimBooking` and
// `rate_claim`: the PRIMARY KEY is the fence, `INSERT … ON CONFLICT DO NOTHING`
// decides the winner, and a claim is permanent unless the winner releases it
// because the gateway call failed (so the operator can retry).
//
// Fails open without D1 (local dev without the binding); production always
// binds it.
import { getDB } from "./config.server";
import { db, schemaOnce } from "./d1.server";

const ensureRefundClaimSchema = schemaOnce((d) => [
  d.prepare(
    `CREATE TABLE IF NOT EXISTS refund_claim (
        key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )`,
  ),
]);

/** Claim the right to issue this refund. True = this caller goes to the
 *  gateway; false = someone already did (or is doing it right now). */
export async function claimRefund(key: string): Promise<boolean> {
  if (!getDB()) return true;
  await ensureRefundClaimSchema();
  const r = await db()
    .prepare(`INSERT INTO refund_claim (key, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING`)
    .bind(key, new Date().toISOString())
    .run();
  return r.meta.changes === 1;
}

/** Give a claim back after the gateway refused, so a retry can win it. Never
 *  call this after a refund SUCCEEDED — the claim is what stops the second one. */
export async function releaseRefundClaim(key: string): Promise<void> {
  if (!getDB()) return;
  await ensureRefundClaimSchema();
  await db().prepare(`DELETE FROM refund_claim WHERE key = ?`).bind(key).run();
}
