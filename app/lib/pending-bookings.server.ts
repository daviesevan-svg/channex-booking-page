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
  /**
   * Made with an API TEST key — nothing about this booking is real.
   *
   * Deliberately separate from `live`. A real guest at a property with live
   * bookings off is also not pushed to Channex, but everything else about them
   * IS real; conflating the two let a test key decrement a real hotel's
   * availability. See booking-side-effects.ts.
   */
  testMode?: boolean;
  /** Search params to carry onto the confirmation page after payment. */
  returnParams: string;
  /** Site origin captured at checkout, for absolute links in emails. */
  origin: string;
  /** Gift-voucher amount held for this checkout — settled onto the voucher
   *  when the booking finalizes, released if it fails. */
  voucherRedemption?: { code: string; amount: number };
  /** Funnel-analytics context captured at checkout, so the purchase step can be
   *  logged at finalize time — which may run from the Stripe webhook, with no
   *  guest request to derive it from. Computed once here, it also stays stable
   *  across the visit key's midnight salt rotation. Absent on API bookings. */
  funnel?: { visitKey: string; country: string | null; device: string | null };
  /** Hosted payment URL (Stripe or Viva). Stashed after the session is created
   *  so a double-submit of the same stay can reuse it instead of minting another. */
  paymentUrl?: string;
}

// 3 hours. Must exceed the Checkout Session's expires_at (60 min, set in
// checkout.tsx) plus webhook/return processing margin, so a completed payment
// always finds its pending record. NOT 3 seconds — 3 * 3600 = 10,800s.
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

// ===== Viva order-code mapping =====
// Viva's success/failure URLs are configured statically on the payment source
// (per property, in THEIR Viva dashboard) — unlike Stripe, the return URL can't
// carry our reference. The guest comes back with only ?s={orderCode}&t={txId},
// so the order code has to find its way back to the pending booking.

/** What /viva/return and the Viva webhook need to resume a checkout. */
export interface VivaOrderRef {
  /** Booking reference — the pending-booking key. */
  ref: string;
  pid: string;
  /** URL segment the checkout ran under (slug or empty on a custom domain),
   *  so redirects rebuild the same pretty base the guest came from. */
  channel: string;
}

const vivaOrderKey = (orderCode: string) => `viva_order:${orderCode}`;

export async function stashVivaOrder(orderCode: string, value: VivaOrderRef): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(vivaOrderKey(orderCode), JSON.stringify(value), { expirationTtl: TTL_SECONDS });
}

export async function getVivaOrder(orderCode: string): Promise<VivaOrderRef | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(vivaOrderKey(orderCode));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VivaOrderRef;
  } catch {
    return null;
  }
}
