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

// ---- the funnel ----
//
// One item shape everywhere, because GA4 joins these events by `item_id` and a
// room that is "r1" in the list and "Garden Suite" in the cart reports as two
// products. Price is always the stay total for that room, matching `purchase`.

export interface TrackedItem {
  item_id: string;
  item_name: string;
  item_variant?: string;
  price: number;
  quantity: 1;
}

const item = (id: string, name: string, price: number, variant?: string): TrackedItem => ({
  item_id: id,
  item_name: name,
  ...(variant ? { item_variant: variant } : {}),
  price: round2(price),
  quantity: 1,
});

export interface StayParams {
  currency: string;
  checkin: string;
  checkout: string;
  nights: number;
  adults: number;
  children: number;
}

/** The stay, on every funnel event — otherwise a hotel can segment its
 *  conversions by length of stay but not the sessions that didn't convert,
 *  which is the comparison that actually answers anything. */
function stayParams(stay: StayParams): Record<string, unknown> {
  return {
    currency: stay.currency,
    checkin: stay.checkin,
    checkout: stay.checkout,
    nights: stay.nights,
    adults: stay.adults,
    children: stay.children,
  };
}

/** The rooms offered for a search. `price` is each room's cheapest all-in stay
 *  total: the number on the card, so a hotel comparing GA4 against what guests
 *  saw is comparing the same thing. */
export function viewItemListEvent(
  rooms: { id: string; title: string; ratePlans: { title: string; allInTotal?: number; totalPrice: string }[] }[],
  stay: StayParams,
): TrackingEvent | null {
  if (!rooms.length) return null;
  const items = rooms.flatMap((r) => {
    const cheapest = r.ratePlans.reduce<{ title: string; price: number } | null>((best, rp) => {
      const price = rp.allInTotal ?? Number(rp.totalPrice);
      if (!Number.isFinite(price)) return best;
      return !best || price < best.price ? { title: rp.title, price } : best;
    }, null);
    return cheapest ? [item(r.id, r.title, cheapest.price, cheapest.title)] : [];
  });
  if (!items.length) return null;
  return {
    event: "view_item_list",
    params: { ...stayParams(stay), item_list_name: "rooms", ecommerce: { items } },
  };
}

/** One room's page. Every rate is an item variant: which rate a guest looked at
 *  before choosing is the question this event exists to answer. */
export function viewItemEvent(
  room: { id: string; title: string; ratePlans: { title: string; allInTotal?: number; totalPrice: string }[] },
  stay: StayParams,
): TrackingEvent | null {
  const items = room.ratePlans
    .map((rp) => ({ rp, price: rp.allInTotal ?? Number(rp.totalPrice) }))
    .filter(({ price }) => Number.isFinite(price))
    .map(({ rp, price }) => item(room.id, room.title, price, rp.title));
  if (!items.length) return null;
  return { event: "view_item", params: { ...stayParams(stay), ecommerce: { items } } };
}

/** The checkout page, valued at the same grand total `purchase` will report —
 *  so checkout-to-purchase drop-off is a comparison of like with like. */
export function beginCheckoutEvent(
  lines: { roomId: string; roomTitle: string; rateTitle: string; total: number }[],
  stay: StayParams,
  grandTotal: number,
): TrackingEvent | null {
  if (!lines.length) return null;
  return {
    event: "begin_checkout",
    params: {
      ...stayParams(stay),
      ecommerce: {
        value: round2(grandTotal),
        currency: stay.currency,
        items: lines.map((l) => item(l.roomId, l.roomTitle, l.total, l.rateTitle)),
      },
    },
  };
}

/**
 * What changed in the cart between two `sel` values.
 *
 * There is no click to hang `add_to_cart` off — the guest navigates with a
 * changed `sel` param, and diffing catches every path into the cart including
 * deep links and the back button, with one implementation instead of one per
 * button.
 *
 * `prev` being null means this is the first `sel` we have seen this session,
 * which is where a shared link carrying three rooms would otherwise report
 * three adds the guest never made. No previous state, no delta.
 */
export function cartDelta(
  prev: string | null,
  next: string,
  resolve: (token: string) => { roomId: string; roomTitle: string; rateTitle: string; total: number } | undefined,
  stay: StayParams,
): TrackingEvent[] {
  if (prev === null || prev === next) return [];
  const tokens = (sel: string) => sel.split(",").map((t) => t.trim()).filter(Boolean);
  const before = tokens(prev);
  const after = tokens(next);

  // Multiset difference: the same room can legitimately be in the cart twice,
  // and a Set would silently swallow the second one.
  const remaining = [...before];
  const added: string[] = [];
  for (const t of after) {
    const i = remaining.indexOf(t);
    if (i === -1) added.push(t);
    else remaining.splice(i, 1);
  }

  const build = (event: string, list: string[]): TrackingEvent[] => {
    const items = list.flatMap((t) => {
      const line = resolve(t);
      return line ? [item(line.roomId, line.roomTitle, line.total, line.rateTitle)] : [];
    });
    return items.length ? [{ event, params: { ...stayParams(stay), ecommerce: { items } } }] : [];
  };

  return [...build("add_to_cart", added), ...build("remove_from_cart", remaining)];
}
