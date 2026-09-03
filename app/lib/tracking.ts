// The measurement payloads. Pure functions over a booking record — no DOM, no
// globals, no fetches — because every correctness risk in this feature is
// concentrated in what the numbers say, and numbers are testable.
//
// The rule that shapes all of it: `value` is what the guest was actually
// charged, read from the stored booking, never recomputed from the URL. The
// confirmation page derives its DISPLAY from query params, and a guest who
// edits those changes what the page shows. If revenue were built the same way,
// a guest could edit the hotel's Google Ads reporting from the address bar, and
// any drift from what Stripe captured would surface as revenue that never
// reconciles.
import type { BookingRecord } from "./bookings.server";
import type { AnalyticsSettings } from "./content";

/** A GA4 ecommerce event, ready to push. `event` is the GA4 name; everything
 *  else is its parameters. */
export interface TrackingEvent {
  event: string;
  params: Record<string, unknown>;
  /** Google Ads' separate send_to, present when the hotel configured a
   *  conversion. Firing it is gated on live consent in the browser. */
  adsConversion?: { sendTo: string; value: number; currency: string; transactionId: string };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Whole days between today and arrival — how far ahead people book, which is
 *  the single most useful dimension a hotel can segment ads on. */
function leadDays(createdAt: string, checkin: string): number {
  const from = Date.parse(createdAt.slice(0, 10));
  const to = Date.parse(checkin);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * `purchase`, from the stored booking.
 *
 * Returns null for a booking that isn't revenue — a failed one (the guest paid,
 * the booking couldn't be confirmed and was refunded) or a cancelled one
 * reloaded later. Reporting either inflates ROAS permanently, and it is the
 * kind of wrong that nobody notices because the number only ever looks better.
 */
export function purchaseEvent(
  booking: BookingRecord,
  opts: { propertyId: string; analytics?: AnalyticsSettings },
): TrackingEvent | null {
  if (booking.status === "failed") return null;
  if (booking.lifecycle === "cancelled") return null;

  const tax = round2((booking.pricing?.taxLines ?? []).reduce((n, l) => n + l.amount, 0));
  const roomSubtotal = round2(booking.rooms.reduce((n, r) => n + r.total, 0));
  const extrasTotal = round2((booking.extras ?? []).reduce((n, e) => n + e.amount, 0));
  const dueNow = round2(booking.consent?.dueNow ?? booking.payment?.amount ?? 0);
  const adults = booking.rooms.reduce((n, r) => n + r.adults, 0);
  const children = booking.rooms.reduce((n, r) => n + r.children, 0);

  const params: Record<string, unknown> = {
    ecommerce: {
      transaction_id: booking.reference,
      // The grand total, the figure that reconciles against Stripe. Anyone who
      // wants a different basis has the components below and can compute it in
      // GTM — better than a setting, which would only create ambiguity about
      // which number a given hotel's ROAS was built on.
      value: round2(booking.total),
      currency: booking.currency,
      tax,
      items: booking.rooms.map((r) => ({
        item_id: r.roomId,
        item_name: r.roomTitle,
        item_variant: r.rateTitle,
        // The room's STAY total with quantity 1, not a nightly rate × nights:
        // the multiplication reintroduces rounding drift, and item revenue
        // stops summing to the transaction total. `nights` is a parameter.
        price: round2(r.total),
        quantity: 1,
      })),
    },
    nights: booking.nights,
    checkin: booking.checkin,
    checkout: booking.checkout,
    rooms: booking.rooms.length,
    adults,
    children,
    lead_days: leadDays(booking.createdAt, booking.checkin),
    room_subtotal: roomSubtotal,
    extras_total: extrasTotal,
    due_now: dueNow,
    balance_due: round2(booking.total - dueNow),
    promo_code: booking.promo?.code ?? "",
    property_id: opts.propertyId,
    // A captured payment and a card held as a guarantee are different money. A
    // hotel taking a 30% deposit can reconcile GA4 against Stripe deposits
    // without us having guessed which they meant.
    payment_type: booking.payment ? (booking.payment.mode === "setup" ? "guarantee" : booking.payment.provider) : "none",
  };

  // Built whenever the hotel configured one, and NOT gated on consent here.
  // This runs in a loader, where the only consent visible is whatever cookie
  // arrived with the request — a guest who changed their mind a second ago
  // would be judged on a stale answer. Whether it is FIRED is decided in the
  // browser against live state (see components/tracking-events.tsx); carrying
  // the config to a guest who declined sends nothing and costs nothing.
  const a = opts.analytics;
  const conversion =
    a?.adsConversionId && a.adsConversionLabel
      ? {
          sendTo: `${a.adsConversionId}/${a.adsConversionLabel}`,
          value: round2(booking.total),
          currency: booking.currency,
          transactionId: booking.reference,
        }
      : undefined;

  return { event: "purchase", params, adsConversion: conversion };
}

/** Click IDs and campaign parameters worth keeping off a landing URL. */
export const CLICK_PARAMS = ["gclid", "gbraid", "wbraid", "fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

export type ClickAttribution = Partial<Record<(typeof CLICK_PARAMS)[number], string>>;

/**
 * The advertising parameters on a URL.
 *
 * Kept because they are unrecoverable: a guest arrives on `?gclid=…`, navigates
 * once, and the only copy of that click ID is gone. Whether it may be STORED is
 * a separate question with a different answer — see attribution.ts.
 */
export function clickAttribution(search: URLSearchParams | string): ClickAttribution {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const out: ClickAttribution = {};
  for (const key of CLICK_PARAMS) {
    const v = params.get(key)?.trim();
    // Bound it: this ends up on a booking record and in a cookie, and a URL
    // parameter is attacker-controlled input like any other.
    if (v) out[key] = v.slice(0, 200);
  }
  return out;
}
