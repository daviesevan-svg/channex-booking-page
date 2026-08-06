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
import { computePricing, type TaxConfig } from "./pricing";
import { describePolicy, ratePolicyOf } from "./rate-policy";
import { roomCapacity } from "./occupancy";
import type { GateReason } from "./catalog.server";

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
    // Property-wide structured amenities (fixed vocabulary — same keys as room
    // `amenities`) + the enum ones keyed by name (parking_type/pool_type/…).
    amenities: settings.vrAmenities ?? [],
    amenity_options: settings.vrAmenityOptions ?? {},
    // Unit size (single-unit properties): null until the host sets it.
    unit_size: {
      bedrooms: settings.vrBedrooms ?? null,
      bathrooms: settings.vrBathrooms ?? null,
      beds: settings.vrBeds ?? null,
    },
    cover_image: settings.coverImage ?? null,
    logo: settings.logoImage ?? null,
    logo_hide_name: settings.logoHideName === true, // true = show logo only, no name text
    theme: {
      accent,
      background: settings.customBg ?? null,
      font: settings.themeFont ?? null, // curated font-pair id; null = default fonts
    },
    pricing_display: {
      taxes_inclusive: settings.taxesInclusive === true,
      taxes: (settings.taxes ?? []).map((t) => ({ name: t.name, rate_percent: t.rate })),
      fees: (settings.fees ?? []).map((f) => ({
        name: f.name,
        kind: f.kind,
        amount: f.amount,
        taxable: f.taxable,
        // Fixed fees only: how the amount multiplies. "booking" = flat per stay.
        basis: f.kind === "fixed" ? (f.basis ?? "booking") : null,
      })),
      city_tax:
        ct?.enabled && (ct.amount > 0 || ct.seasons?.some((s) => s.amount > 0))
          ? {
              name: ct.name,
              amount: ct.amount,
              basis: ct.basis,
              taxable: ct.taxable,
              children_exempt: ct.childrenExempt,
              max_nights: ct.maxNights > 0 ? ct.maxNights : null,
              // Seasonal nightly rates (annual recurring MM-DD ranges; a range
              // may wrap the year end). Each night is charged at its date's
              // rate; dates outside every season use `amount`. null = flat.
              seasons: ct.seasons?.length
                ? ct.seasons.map((s) => ({ from: s.from, to: s.to, amount: s.amount }))
                : null,
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
    amenities: r.amenities ?? [],
    max_adults: r.maxAdults,
    max_guests: r.maxGuests,
    cleaning_fee: r.cleaningFee ?? 0,
  };
}

/** Context needed to price a rate all-in and describe its policy. */
export interface StayContext {
  nights: number;
  adults: number;
  children: number;
  checkin: string;
  taxConfig: TaxConfig;
  /** Rate definitions by id, for the policy summary. */
  policyByRateId: Map<string, ReturnType<typeof describePolicy>>;
}

function serializeRatePlan(rp: RatePlan, room: RoomWithRates, ctx?: StayContext) {
  const base = Number(rp.totalPrice);
  // The ALL-IN total, which is the number a caller should quote. `total_price` is
  // the room only; taxes, fees and the cleaning fee land on top, so quoting it
  // alone understates the bill — and an AI agent reading this payload has no
  // other way to know that.
  const allIn =
    ctx && Number.isFinite(base)
      ? Math.round(
          computePricing(
            {
              base,
              nights: ctx.nights,
              adults: ctx.adults,
              children: ctx.children,
              rooms: 1,
              cleaningFee: room.cleaningFee ?? 0,
              taxableExtras: 0,
              checkin: ctx.checkin,
            },
            ctx.taxConfig,
          ).total * 100,
        ) / 100
      : null;
  const policy = ctx?.policyByRateId.get(rp.parentRatePlanId ?? rp.id) ?? null;
  return {
    id: rp.id,
    parent_rate_id: rp.parentRatePlanId ?? rp.id,
    title: rp.title,
    meal_plan: rp.mealPlan ?? null,
    currency: rp.currency ?? null,
    /** Room only, before taxes and fees. */
    total_price: rp.totalPrice,
    /** Everything the guest pays for this room: taxes, fees and cleaning included. */
    total_price_all_in: allIn === null ? null : allIn.toFixed(2),
    /** All-in, divided by nights — for "£x a night" without the caller guessing. */
    per_night_all_in: allIn === null || !ctx?.nights ? null : (Math.round((allIn / ctx.nights) * 100) / 100).toFixed(2),
    nights: ctx?.nights ?? null,
    available: rp.availability ?? null,
    occupancy: rp.occupancy,
    /** True when this rate prices per adult — total_price already reflects the
     *  requested party, so callers need no arithmetic; this is informational. */
    per_person: rp.perPerson ?? false,
    refundable: rp.refundable ?? null,
    free_cancel_until: rp.freeCancelUntilISO ?? null,
    /** Plain sentences, the same ones the guest is shown at checkout. */
    policy_summary: policy ? { payment: policy.payment, cancellation: policy.cancellation, no_show: policy.noShow || null } : null,
    description: rp.description ?? null,
    inclusions: rp.inclusions ?? [],
    offer: rp.offer ? { name: rp.offer.name, percent: rp.offer.percent, original_total_price: rp.offer.originalTotalPrice } : null,
  };
}

/** Priced rooms+rates for a chosen stay (GET /v1/availability). */
export function serializeAvailabilityRoom(r: RoomWithRates, ctx?: StayContext) {
  const { maxAdults, capacity } = roomCapacity(r);
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    images: (r.photos ?? []).map((p) => p.url),
    facilities: r.facilities ?? [],
    amenities: r.amenities ?? [],
    cleaning_fee: r.cleaningFee ?? 0,
    /** So a caller can judge party fit without inferring it from the rates. */
    max_adults: maxAdults,
    sleeps: capacity,
    rates: r.ratePlans.map((rp) => serializeRatePlan(rp, r, ctx)),
  };
}

/** Rooms and rates that exist but weren't offered, and why. Without this a caller
 *  can only see that something is absent — the same silent-vanish problem the
 *  date picker had. `min_stay` carries the nights needed so a caller can propose
 *  a stay that would actually work. */
export function serializeGateReason(g: GateReason) {
  return {
    room_id: g.roomId,
    room_title: g.roomTitle,
    rate_id: g.rateId ?? null,
    rate_title: g.rateTitle ?? null,
    reason: g.reason,
    min_nights: g.minNights ?? null,
    message:
      g.reason === "sold_out"
        ? "No availability for these dates."
        : g.reason === "stop_sell"
          ? "Closed for sale on one or more of these nights."
          : g.reason === "min_stay"
            ? `Needs a minimum stay of ${g.minNights ?? "more"} nights.`
            : g.reason === "closed_to_arrival"
              ? "Arrivals are not accepted on the check-in date."
              : "Departures are not accepted on the check-out date.",
  };
}

/** Policy sentences per rate id, built once for a whole availability response.
 *  `anchor` is the property's cancellation cut-off time — without it the
 *  sentences would name 18:00 while the property's deadlines use its own. */
export function policyMap(
  rates: CatalogRate[],
  anchor?: string,
): Map<string, ReturnType<typeof describePolicy>> {
  return new Map(rates.map((r) => [r.id, describePolicy(ratePolicyOf(r), anchor)]));
}

/** Rate plan definitions + policy (GET /v1/rates). */
export function serializeRate(r: CatalogRate) {
  return {
    id: r.id,
    title: r.title,
    meal_plan: r.mealPlan ?? null,
    prices: r.prices, // base nightly price by room id (per adult when per_person), property currency
    per_person: r.perPerson ?? false,
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
    voucher: b.voucher
      ? { code: b.voucher.code, title: b.voucher.title ?? null, amount: b.voucher.amount ?? null }
      : null,
    payment: b.payment
      ? {
          provider: b.payment.provider ?? "stripe",
          mode: b.payment.mode, // "payment" | "setup"
          amount: b.payment.amount ?? null,
          currency: b.payment.currency ?? null,
          card_last4: b.payment.cardLast4 ?? null,
          refunded: b.payment.refund ? { amount: b.payment.refund.amount, at: b.payment.refund.at } : null,
        }
      : null,
  };
}
