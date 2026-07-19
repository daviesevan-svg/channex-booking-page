// A voucher purchase that's been fully built but not yet issued, because the
// buyer was sent to Stripe's hosted Checkout to pay. Stashed in KV keyed by a
// purchase reference; consumed (finalized + deleted) by the return URL and/or
// the webhook. Mirrors pending-bookings.server.ts — the voucher CODE is
// generated at stash time, so both finalizers insert the same D1 row and the
// (pid, code) claim dedupes.
import { getConfigKV } from "./config.server";
import type { VoucherRecord } from "./vouchers";

export interface PendingVoucher {
  pid: string;
  /** Connected Stripe account the Checkout Session runs on. */
  account: string;
  /** Fully-built voucher record minus payment (decided at finalize time). */
  record: Omit<VoucherRecord, "payment">;
  /** Whether this was a real (Stripe) sale vs a simulated test-mode one. */
  live: boolean;
  /** URL segment (may be a slug) for redirects/links. */
  channel: string;
  /** Site origin captured at purchase, for absolute links in emails. */
  origin: string;
}

// 3 hours — must exceed the Checkout Session's 60-min expires_at plus margin
// (same reasoning as pending-bookings.server.ts).
const TTL_SECONDS = 3 * 3600;
const key = (ref: string) => `pending_voucher:${ref}`;

export async function stashPendingVoucher(ref: string, pending: PendingVoucher): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(key(ref), JSON.stringify(pending), { expirationTtl: TTL_SECONDS });
}

export async function getPendingVoucher(ref: string): Promise<PendingVoucher | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(key(ref));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingVoucher;
  } catch {
    return null;
  }
}

export async function deletePendingVoucher(ref: string): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.delete(key(ref));
}
