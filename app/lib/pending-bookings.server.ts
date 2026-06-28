// A booking that's been fully priced + consented but not yet created, because
// the guest was sent to Stripe's hosted Checkout to pay. Stashed in KV keyed by
// the booking reference; consumed (finalized + deleted) by the return URL and/or
// the webhook. TTL covers the longest reasonable Stripe session lifetime.
import { getConfigKV } from "./config.server";
import type { BookingRecord } from "./bookings.server";

/** The booking data captured at checkout, ready to finalize once paid. */
export interface PendingBooking {
  pid: string;
  /** Connected Stripe account the Checkout Session runs on. */
  account: string;
  /** Fully-built record minus the fields decided at finalize time. */
  record: Omit<BookingRecord, "status" | "channexId" | "error" | "inventoryHeld" | "payment">;
  /** The Open Channel booking payload to push to Channex on finalize. */
  channexPayload: unknown;
  /** Whether to push live to Channex (vs simulate). */
  live: boolean;
  /** Search params to carry onto the confirmation page after payment. */
  returnParams: string;
  /** Site origin captured at checkout, for absolute links in emails. */
  origin: string;
}

const TTL_SECONDS = 3 * 3600;
const key = (ref: string) => `pending_booking:${ref}`;

export async function stashPending(ref: string, pending: PendingBooking): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(key(ref), JSON.stringify(pending), { expirationTtl: TTL_SECONDS });
}

export async function getPending(ref: string): Promise<PendingBooking | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(key(ref));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingBooking;
  } catch {
    return null;
  }
}

export async function deletePending(ref: string): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.delete(key(ref));
}
