// Serializers for the management API (/v1/manage/*) — the ADMIN's view of a
// resource, as opposed to api-serialize.ts which shapes the guest/booking
// view. Snake_case like the rest of /v1.
//
// Two rules from docs/management-api.md:
// - No secrets and no gateway internals ever leave: payment serialization
//   carries what the admin bookings screen shows (provider, amount, card
//   last4, refund) and never account/session/intent/customer ids.
// - These are also the round-trip shapes the write endpoints will accept
//   (minus server-owned fields like channex_rate_ids), so keep them faithful
//   to the stored records rather than inventing a prettier remix.
import type { BookingRecord } from "./bookings.server";
import type { CatalogRate, CatalogRoom } from "./catalog.server";
import type { Extra } from "./extras";
import type { Promotion } from "./promotions";
import type { SiteSettings } from "./content";
import type { PropertyRef } from "./properties.server";

export function serializeManageRoom(r: CatalogRoom) {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    images: r.images,
    max_adults: r.maxAdults,
    max_guests: r.maxGuests,
    cleaning_fee: r.cleaningFee ?? null,
    facilities: r.facilities,
    amenities: r.amenities ?? [],
    position: r.position,
    translations: r.translations ?? {},
    created_at: r.createdAt,
  };
}

export function serializeManageRate(r: CatalogRate) {
  return {
    id: r.id,
    title: r.title,
    meal_plan: r.mealPlan ?? null,
    active: r.active,
    /** Base nightly price per room id — a rate is offered on a room only when
     *  it has a price here. NOT the ARI grid: date-level prices come from the
     *  channel and are read via /v1/manage/ari. */
    prices: r.prices,
    occupancy_pricing: r.occupancyPricing ?? null,
    occupancy_pricing_by_room: r.occupancyPricingByRoom ?? {},
    policy: r.policy ?? null,
    inclusions: r.inclusions,
    /** Read-only: the per-room Channex rate_plan_ids ARI and bookings key by.
     *  Absent (empty) for native rates. Never writable through this API. */
    channex_rate_ids: r.channexRateIds ?? {},
    created_at: r.createdAt,
  };
}

export function serializeManageExtra(e: Extra) {
  return {
    id: e.id,
    name: e.name,
    description: e.desc ?? null,
    image: e.image ?? null,
    unit: e.unit,
    price: e.price ?? null,
    options: e.options ?? [],
    fields: e.fields ?? [],
    info_title: e.infoTitle ?? null,
    scope: e.scope ?? "room",
    taxable: e.taxable !== false,
    exclude_rooms: e.excludeRooms ?? [],
    exclude_rates: e.excludeRates ?? [],
    active: e.active,
    position: e.position,
    created_at: e.createdAt,
  };
}

export function serializeManagePromotion(p: Promotion) {
  return {
    id: p.id,
    trigger: p.trigger ?? "code",
    code: p.code ?? null,
    name: p.name ?? null,
    kind: p.kind ?? "discount",
    type: p.type,
    value: p.value,
    conditions: p.conditions ?? null,
    inclusions: p.inclusions ?? [],
    exclusive: p.exclusive ?? false,
    enabled: p.enabled,
    published: p.publish ?? null,
    created_at: p.createdAt,
  };
}

/** The property + settings view: the fields the spec's phase-A PATCH will
 *  accept, plus read-only context an agent needs (connectivity, payments
 *  state, website state). Never the whole SiteSettings — several fields are
 *  deliberately absent (stripeAccountId, email sender internals, Google VR
 *  block) until their phase adds them. */
export function serializeManageProperty(ref: PropertyRef, s: SiteSettings) {
  return {
    id: ref.id,
    name: ref.name,
    slug: ref.slug ?? null,
    public: ref.public ?? false,
    directory_listed: ref.directoryListed ?? false,
    currency: s.currency ?? "GBP",
    pricing_mode: s.pricingMode ?? null,
    languages: s.languages ?? [],
    single_unit: s.singleUnit ?? false,
    facilities: s.facilities ?? [],
    checkin_time: s.checkinTime ?? null,
    checkout_time: s.checkoutTime ?? null,
    timezone: s.timezone ?? null,
    booking_cutoff_days: s.bookingCutoffDays ?? null,
    booking_cutoff_time: s.bookingCutoffTime ?? null,
    address: {
      city: s.addressCity ?? null,
      region: s.addressRegion ?? null,
      postal_code: s.addressPostalCode ?? null,
      country: s.addressCountry ?? null,
      latitude: s.latitude ?? null,
      longitude: s.longitude ?? null,
    },
    portal: {
      allow_cancel: s.allowCancel ?? false,
      allow_modify: s.allowModify ?? false,
      auto_refund: s.autoRefund ?? false,
      cancel_deadline_value: s.cancelDeadlineValue ?? null,
      cancel_deadline_unit: s.cancelDeadlineUnit ?? null,
      cancel_anchor_time: s.cancelAnchorTime ?? null,
      modify_deadline_value: s.modifyDeadlineValue ?? null,
      modify_deadline_unit: s.modifyDeadlineUnit ?? null,
      after_deadline_message: s.afterDeadlineMessage ?? null,
    },
    terms_url: s.termsUrl ?? null,
    privacy_url: s.privacyUrl ?? null,
    // Read-only context (writes are UI-only or a later phase; see the spec).
    connected_system: s.connectedSystem ?? null,
    live_booking: s.liveBooking ?? null,
    payments_charges_enabled: s.stripeChargesEnabled ?? false,
    website_enabled: s.websiteEnabled ?? false,
    website_domain: s.websiteDomain ?? null,
  };
}

export function serializeTaxConfig(s: SiteSettings) {
  return {
    taxes_inclusive: s.taxesInclusive ?? false,
    taxes: s.taxes ?? [],
    fees: s.fees ?? [],
    city_tax: s.cityTax ?? null,
  };
}

export function serializeManageBooking(b: BookingRecord) {
  return {
    id: b.id,
    reference: b.reference,
    channex_id: b.channexId ?? null,
    status: b.status,
    lifecycle: b.lifecycle ?? "active",
    error: b.error ?? null,
    created_at: b.createdAt,
    checkin: b.checkin,
    checkout: b.checkout,
    nights: b.nights,
    currency: b.currency,
    total: b.total,
    lang: b.lang ?? null,
    guest: {
      first_name: b.guest.firstName,
      last_name: b.guest.lastName,
      email: b.guest.email,
      phone: b.guest.phone,
      arrival: b.guest.arrival ?? null,
      requests: b.guest.requests ?? null,
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
    promo: b.promo ?? null,
    offer: b.offer ?? null,
    value_adds: b.valueAdds ?? [],
    pricing: b.pricing ?? null,
    voucher: b.voucher ?? null,
    cancelled_at: b.cancelledAt ?? null,
    cancelled_by: b.cancelledBy ?? null,
    // What the admin screen shows — never gateway internals (no account,
    // session, intent, customer or payment-method ids).
    payment: b.payment
      ? {
          provider: b.payment.provider,
          mode: b.payment.mode,
          amount: b.payment.amount ?? null,
          currency: b.payment.currency ?? null,
          card_brand: b.payment.cardBrand ?? null,
          card_last4: b.payment.cardLast4 ?? null,
          refund: b.payment.refund
            ? { amount: b.payment.refund.amount, currency: b.payment.refund.currency ?? null, at: b.payment.refund.at }
            : null,
        }
      : null,
  };
}
