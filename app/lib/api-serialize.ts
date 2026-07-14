// Public JSON shapes for the /v1 API. These are the contract — internal fields
// (inventoryHeld, consent.ip/userAgent, raw Stripe ids, key hashes, etc.) are
// deliberately omitted. Keep these stable.
import type { PropertyRef } from "./properties.server";
import type { CatalogRoom, CatalogRate } from "./catalog.server";
import type { RoomWithRates, RatePlan } from "./channex/types";
import type { BookingRecord } from "./bookings.server";
import type { SiteSettings } from "./content";
import type { Extra } from "./extras";
import type { PropertyOverrides } from "./overrides.server";

/** Everything an external booking frontend needs to render a branded property:
 *  display content (localizable via ?lang=), contact + location, stay logistics,
 *  brand theme tokens, and the tax/fee DISPLAY config — rates from
 *  /v1/availability are room-only, so a client needs this to explain how the
 *  all-in total composes (the authoritative total still comes from
 *  POST /v1/bookings). `accent` is pre-resolved to hex by the caller. */
export function serializePropertyContent(
  p: PropertyRef,
  settings: SiteSettings,
  ov: PropertyOverrides,
  accent: string,
) {
  const ct = settings.cityTax;
  return {
    id: p.id,
    name: p.name,
    hotel_name: ov.hotelName || p.name,
    property_type: ov.propertyType ?? null,
    description: ov.description ?? null,
    address: ov.address ?? null,
    phone: ov.phone ?? null,
    email: ov.email ?? null,
    location: {
      city: settings.addressCity ?? null,
      region: settings.addressRegion ?? null,
      postal_code: settings.addressPostalCode ?? null,
      country: settings.addressCountry ?? null,
      latitude: settings.latitude ?? null,
      longitude: settings.longitude ?? null,
    },
    currency: settings.currency || "GBP",
    timezone: settings.timezone ?? null,
    checkin_time: settings.checkinTime ?? null,
    checkout_time: settings.checkoutTime ?? null,
    languages: settings.languages?.length ? settings.languages : ["en"],
    terms_url: settings.termsUrl ?? null,
    privacy_url: settings.privacyUrl ?? null,
    single_unit: settings.singleUnit === true,
    cover_image: settings.coverImage ?? null,
    logo: settings.logoImage ?? null,
    theme: {
      accent,
      background: settings.customBg ?? null,
      font: settings.themeFont ?? null, // curated font-pair id; null = default fonts
    },
    pricing_display: {
      taxes_inclusive: settings.taxesInclusive === true,
      taxes: (settings.taxes ?? []).map((t) => ({ name: t.name, rate_percent: t.rate })),
      fees: (settings.fees ?? []).map((f) => ({ name: f.name, kind: f.kind, amount: f.amount, taxable: f.taxable })),
      city_tax:
        ct?.enabled && ct.amount > 0
          ? {
              name: ct.name,
              amount: ct.amount,
              basis: ct.basis,
              taxable: ct.taxable,
              children_exempt: ct.childrenExempt,
              max_nights: ct.maxNights > 0 ? ct.maxNights : null,
            }
          : null,
    },
  };
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
    extras: (b.extras ?? []).map((x) => ({
      id: x.id,
      name: x.name,
      option: x.optionName ?? null,
      qty: x.qty,
      amount: x.amount,
      room_title: x.roomTitle ?? null, // null = whole-stay extra
      info: x.infoLine ?? null,
    })),
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
