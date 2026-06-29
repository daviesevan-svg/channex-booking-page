// Public JSON shapes for the /v1 API. These are the contract — internal fields
// (inventoryHeld, consent.ip/userAgent, raw Stripe ids, key hashes, etc.) are
// deliberately omitted. Keep these stable.
import type { PropertyRef } from "./properties.server";
import type { CatalogRoom, CatalogRate } from "./catalog.server";
import type { RoomWithRates, RatePlan } from "./channex/types";
import type { BookingRecord } from "./bookings.server";
import type { Extra } from "./extras";

export function serializeProperty(p: PropertyRef) {
  return { id: p.id, name: p.name };
}

/** Unpriced room content (GET /v1/rooms) — for rendering room cards. */
export function serializeRoom(r: CatalogRoom) {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    images: r.images ?? [],
    facilities: r.facilities ?? [],
    max_adults: r.maxAdults,
    max_guests: r.maxGuests,
    cleaning_fee: r.cleaningFee ?? 0,
  };
}

function serializeRatePlan(rp: RatePlan) {
  return {
    id: rp.id,
    parent_rate_id: rp.parentRatePlanId ?? rp.id,
    title: rp.title,
    meal_plan: rp.mealPlan ?? null,
    currency: rp.currency ?? null,
    total_price: rp.totalPrice,
    available: rp.availability ?? null,
    occupancy: rp.occupancy,
    refundable: rp.refundable ?? null,
    free_cancel_until: rp.freeCancelUntilISO ?? null,
    description: rp.description ?? null,
    inclusions: rp.inclusions ?? [],
    offer: rp.offer ? { name: rp.offer.name, percent: rp.offer.percent, original_total_price: rp.offer.originalTotalPrice } : null,
  };
}

/** Priced rooms+rates for a chosen stay (GET /v1/availability). */
export function serializeAvailabilityRoom(r: RoomWithRates) {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    images: (r.photos ?? []).map((p) => p.url),
    facilities: r.facilities ?? [],
    cleaning_fee: r.cleaningFee ?? 0,
    rates: r.ratePlans.map(serializeRatePlan),
  };
}

/** Rate plan definitions + policy (GET /v1/rates). */
export function serializeRate(r: CatalogRate) {
  return {
    id: r.id,
    title: r.title,
    meal_plan: r.mealPlan ?? null,
    prices: r.prices, // base nightly price by room id, property currency
    refundable: r.refundable,
    cancel_deadline_value: r.cancelDeadlineValue ?? null,
    cancel_deadline_unit: r.cancelDeadlineUnit ?? null,
    cancellation_note: r.cancellationNote ?? null,
    inclusions: r.inclusions ?? [],
    policy: r.policy ?? null,
  };
}

/** Extras catalog (GET /v1/extras). */
export function serializeExtra(e: Extra) {
  return {
    id: e.id,
    name: e.name,
    description: e.desc ?? null,
    unit: e.unit,
    price: e.price ?? null,
    scope: e.scope ?? "room",
    taxable: e.taxable !== false,
    options: e.options ?? null,
    fields: e.fields ?? null,
  };
}

/** A booking as the API exposes it — drops internal/PII-sensitive fields. */
export function serializeBooking(b: BookingRecord) {
  return {
    id: b.id,
    reference: b.reference,
    status: b.status,
    lifecycle: b.lifecycle ?? "active",
    confirmation_id: b.channexId ?? null,
    created_at: b.createdAt,
    currency: b.currency,
    checkin: b.checkin,
    checkout: b.checkout,
    nights: b.nights,
    total: b.total,
    guest: {
      first_name: b.guest.firstName,
      last_name: b.guest.lastName,
      email: b.guest.email,
      phone: b.guest.phone,
    },
    rooms: b.rooms.map((r) => ({
      room_id: r.roomId,
      room_title: r.roomTitle,
      rate_id: r.rateId,
      rate_title: r.rateTitle,
      adults: r.adults,
      children: r.children,
      total: r.total,
    })),
    extras: (b.extras ?? []).map((x) => ({ id: x.id, name: x.name, qty: x.qty, amount: x.amount })),
    cancellation: b.cancellation ? { refundable: b.cancellation.refundable, cancel_by: b.cancellation.cancelByISO } : null,
    payment: b.payment
      ? {
          mode: b.payment.mode, // "payment" | "setup"
          amount: b.payment.amount ?? null,
          currency: b.payment.currency ?? null,
          card_last4: b.payment.cardLast4 ?? null,
          refunded: b.payment.refund ? { amount: b.payment.refund.amount, at: b.payment.refund.at } : null,
        }
      : null,
  };
}
