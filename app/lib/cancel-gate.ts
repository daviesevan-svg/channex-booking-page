// Whether a booking may be cancelled right now, and what comes back if it is.
//
// One answer for the guest's manage page (the button, its tooltip, the
// confirmation with the numbers in it, and the server re-check the action
// runs) and for the admin's refund field (what the policy says is owed). The
// two used to compute this separately, and with a schedule of several bands
// "separately" is how they would come to disagree.
//
// Client-safe: routes render from it and their actions gate on it.
import { bandAt, bandRefund, isPartialBand } from "./cancel-bands";
import type { CancelBand } from "./cancellation";
import type { BookingRecord } from "./bookings.server";

type Gateable = Pick<BookingRecord, "cancellation" | "payment">;

export type CancelGate =
  | {
      canCancel: true;
      reason: "ok";
      /** What was actually charged (0 for a guarantee-card booking). */
      charged: number;
      /** What the policy owes back if cancelled now — all of `charged` in the
       *  free window, part of it inside a paying band. */
      refund: number;
      /** The band we are in, or null for a booking from before bands existed. */
      band: CancelBand | null;
    }
  | { canCancel: false; reason: "notAllowed" | "nonRefundable" | "deadline" };

/** Money the guest has actually paid us. A guarantee card (`mode: "setup"`)
 *  is not a charge. */
export function chargedAmount(booking: Gateable): number {
  const p = booking.payment;
  return p?.mode === "payment" ? (p.amount ?? 0) : 0;
}

/**
 * The guest's gate.
 *
 * With a schedule: cancel in the free band for everything back, in a paying
 * band for part of it — the confirmation names both numbers — and not at all
 * once only the last band is left ("contact the hotel", as before). Without
 * one (bookings made before multi-tier shipped) the single deadline decides,
 * exactly as it always did.
 */
export function cancelGate(booking: Gateable, allowCancel: boolean, nowMs = Date.now()): CancelGate {
  if (!allowCancel) return { canCancel: false, reason: "notAllowed" };
  const c = booking.cancellation;
  if (c && c.refundable === false) return { canCancel: false, reason: "nonRefundable" };
  const charged = chargedAmount(booking);

  const bands = c?.bands;
  if (bands && bands.length > 0) {
    const band = bandAt(bands, nowMs);
    if (!band) return { canCancel: false, reason: "deadline" };
    if (band.penalty === "none") return { canCancel: true, reason: "ok", charged, refund: charged, band };
    if (isPartialBand(band)) return { canCancel: true, reason: "ok", charged, refund: bandRefund(band, charged), band };
    return { canCancel: false, reason: "deadline" };
  }

  if (c?.cancelByISO && nowMs > Date.parse(c.cancelByISO)) return { canCancel: false, reason: "deadline" };
  return { canCancel: true, reason: "ok", charged, refund: charged, band: null };
}

/**
 * What the policy says is owed back if this booking were cancelled at `nowMs`
 * — the admin's pre-filled refund amount. Unlike the guest's gate it answers
 * even in the last band (0) and for a non-refundable rate (0): the admin may
 * still refund, and should see what the policy says first.
 *
 * Null when there is nothing to refund: no charge, or already refunded.
 */
export function policyRefundNow(booking: Gateable, nowMs = Date.now()): { charged: number; refund: number } | null {
  const p = booking.payment;
  if (!p || p.mode !== "payment" || p.refund) return null;
  const charged = p.amount ?? 0;
  if (charged <= 0) return null;

  const c = booking.cancellation;
  if (!c) return { charged, refund: charged };
  if (c.refundable === false) return { charged, refund: 0 };
  if (c.bands && c.bands.length > 0) {
    const band = bandAt(c.bands, nowMs);
    return { charged, refund: band ? bandRefund(band, charged) : 0 };
  }
  const closed = c.cancelByISO ? nowMs > Date.parse(c.cancelByISO) : false;
  return { charged, refund: closed ? 0 : charged };
}
