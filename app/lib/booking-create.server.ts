// Shared booking-build step: turns resolved cart + guest + pricing into a
// PendingBooking (the Open Channel payload + the draft record, minus fields
// decided at finalize). Used by BOTH the web checkout action and POST /v1/bookings
// so the two paths build identical bookings. The caller does validation,
// pricing, policy and consent; this only assembles the result.
import { addDays, format, parseISO } from "date-fns";

import type { BookingRecord } from "./bookings.server";
import type { PendingBooking } from "./pending-bookings.server";
import type { ResolvedLine } from "./cart";
import type { AppliedPromo } from "./promotions";
import type { ResolvedExtra } from "./extras";
import { resolveBookingCancellation } from "./policy.server";
import { getRates, rateChannexId } from "./catalog.server";
import { getProperty } from "./properties.server";

/** Channex validates arrival_hour as strict HH:MM, but our arrival field is
 *  free text ("10 am ", "ca. 16 Uhr"). Extract a time when one is recognisable
 *  and drop the field otherwise — an unparseable arrival note must never fail
 *  the booking push. The raw text still reaches the hotel via the record. */
export function normalizeArrivalHour(raw: string | undefined): string | undefined {
  const m = raw?.match(/\b(\d{1,2})(?:[:.h](\d{2})|h)?\s*(am|pm)?\b/i);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export interface PreparePendingInput {
  pid: string;
  reference: string;
  checkin: string;
  checkout: string;
  currency: string;
  nights: number;
  lines: ResolvedLine[];
  guest: BookingRecord["guest"];
  /** Final amount the guest owes (room + taxes/fees + extras), already computed. */
  grandTotal: number;
  /** Pre-discount room subtotal and the post-promo subtotal — their ratio is
   *  spread across the Channex day prices so what we send equals what we charge. */
  baseTotal: number;
  discountedTotal: number;
  applied?: AppliedPromo;
  offer?: AppliedPromo;
  /** Value-added offers this stay qualified for, as the guest was shown them. */
  valueAdds?: { name: string; inclusions: string[] }[];
  /** Taxes & fees breakdown from computePricing — pushed to Channex as services
   *  (the day prices carry only the room amounts) and snapshotted on the record
   *  for display. taxLines = on-top VAT; taxIncluded = VAT inside gross prices. */
  pricing: {
    charges: { label: string; amount: number }[];
    taxLines: { label: string; amount: number }[];
    taxIncluded: number;
  };
  extraLines: ResolvedExtra[];
  consent: BookingRecord["consent"];
  lang: string;
  live: boolean;
  /** Connected Stripe account (empty string when none). */
  account: string;
  origin: string;
  returnParams: string;
  providerCode?: string;
  /** Gift voucher applied at checkout: `amount` of the due-now covered by the
   *  voucher (the Stripe charge, if any, is the remainder). */
  voucherPayment?: { code: string; amount: number };
  /** Funnel-analytics context from the checkout request (absent on API bookings). */
  funnel?: PendingBooking["funnel"];
}

export async function preparePendingBooking(input: PreparePendingInput): Promise<PendingBooking> {
  const { pid, reference, checkin, checkout, currency, nights, lines, guest, grandTotal } = input;

  // Defence in depth: never build a booking for a property that no longer
  // exists (deleted from the registry) — its catalog/ARI data can linger in KV.
  if (!(await getProperty(pid))) throw new Error("This property is no longer available.");

  // A consolidated imported rate carries per-room Channex rate ids; the push
  // (and Channex's mapping) key by the room's real id, while our line keeps our
  // catalog id for policy/cancellation lookups. Resolve per line for the push.
  const ratesById = new Map((await getRates(pid)).map((r) => [r.id, r]));
  const pushRateId = (roomId: string, rateId: string) => {
    const r = ratesById.get(rateId);
    return r ? rateChannexId(r, roomId) : rateId;
  };

  // Open Channel payload — each room's (promo-adjusted) total is spread across
  // the stay nights as days[], so the price we send is exactly what we charge.
  const stayDates = Array.from({ length: nights }, (_, i) => format(addDays(parseISO(checkin), i), "yyyy-MM-dd"));
  const ratio = input.baseTotal > 0 ? input.discountedTotal / input.baseTotal : 1;

  // Everything charged on top of the room day-prices rides as Channex services
  // (excluded: true = not part of the day prices, so Channex adds them to the
  // booking total): fees + city tax + cleaning, on-top VAT, and extras. Then
  // sum(days) + sum(services) equals exactly what the guest paid. Inclusive-mode
  // VAT is already inside the day prices, so it sends no service line.
  const partySize = lines.reduce((s, l) => s + l.occupancy.adults + l.occupancy.children, 0);
  const service = (type: "Fee" | "Extra", name: string, amount: number) => ({
    type,
    name,
    price_mode: "Per stay",
    price_per_unit: amount.toFixed(2),
    total_price: amount.toFixed(2),
    persons: partySize,
    nights,
    excluded: true,
  });
  const services = [
    ...input.pricing.charges.map((c) => service("Fee", c.label, c.amount)),
    ...input.pricing.taxLines.map((t) => service("Fee", t.label, t.amount)),
    ...input.extraLines.map((x) =>
      service("Extra", x.optionName ? `${x.name} — ${x.optionName}` : x.name, x.amount),
    ),
  ].filter((s) => Number(s.total_price) > 0);

  // Notes reach the hotel's PMS: guest special requests, an arrival note that
  // didn't parse into arrival_hour, and the gift-voucher payment flag.
  const arrivalHour = normalizeArrivalHour(guest.arrival);
  const noteLines = [
    ...(guest.requests?.trim() ? [`Guest requests: ${guest.requests.trim()}`] : []),
    ...(guest.arrival?.trim() && !arrivalHour ? [`Arrival: ${guest.arrival.trim()}`] : []),
    ...(input.voucherPayment
      ? [`Paid ${input.voucherPayment.amount.toFixed(2)} with gift voucher ${input.voucherPayment.code}`]
      : []),
  ];

  const channexPayload = {
    status: "new",
    ...(noteLines.length ? { notes: noteLines.join("\n") } : {}),
    provider_code: input.providerCode,
    hotel_code: pid,
    ota_name: input.providerCode || "Direct",
    reservation_id: reference,
    currency,
    arrival_date: checkin,
    departure_date: checkout,
    arrival_hour: arrivalHour,
    customer: { name: guest.firstName, surname: guest.lastName, mail: guest.email, phone: guest.phone },
    rooms: lines.map((l, index) => {
      const lineTotal = Math.round(l.total * ratio * 100) / 100;
      const per = Math.round((lineTotal / nights) * 100) / 100;
      return {
        index,
        room_type_code: l.roomId,
        occupancy: { adults: l.occupancy.adults, children: l.occupancy.children, infants: l.occupancy.infants ?? 0 },
        guests: [{ name: guest.firstName, surname: guest.lastName }],
        days: stayDates.map((date, i) => ({
          date,
          // last night absorbs the rounding remainder so days sum to lineTotal
          price: (i === nights - 1 ? Math.round((lineTotal - per * (nights - 1)) * 100) / 100 : per).toFixed(2),
          rate_plan_code: pushRateId(l.roomId, l.rateId),
        })),
      };
    }),
    ...(services.length ? { services } : {}),
  };

  const cancellation = await resolveBookingCancellation(pid, lines.map((l) => l.rateId), checkin);

  // The record, built but not yet created. status/channexId/payment are decided at finalize.
  const record: PendingBooking["record"] = {
    id: crypto.randomUUID(),
    reference,
    lifecycle: "active",
    cancellation,
    createdAt: new Date().toISOString(),
    lang: input.lang,
    currency,
    checkin,
    checkout,
    nights,
    total: grandTotal,
    promo: input.applied,
    offer: input.offer,
    valueAdds: input.valueAdds?.length ? input.valueAdds : undefined,
    pricing: input.pricing,
    extras: input.extraLines.length ? input.extraLines : undefined,
    consent: input.consent,
    guest: {
      firstName: guest.firstName,
      lastName: guest.lastName,
      email: guest.email,
      phone: guest.phone,
      arrival: guest.arrival || undefined,
      requests: guest.requests || undefined,
    },
    rooms: lines.map((l) => ({
      roomId: l.roomId,
      roomTitle: l.roomTitle,
      rateId: l.rateId,
      rateTitle: l.rateTitle,
      adults: l.occupancy.adults,
      children: l.occupancy.children,
      total: l.total,
    })),
  };

  if (input.voucherPayment) {
    record.voucher = { code: input.voucherPayment.code, amount: input.voucherPayment.amount };
  }

  return {
    pid,
    account: input.account,
    record,
    channexPayload,
    live: input.live,
    returnParams: input.returnParams,
    origin: input.origin,
    voucherRedemption: input.voucherPayment,
    funnel: input.funnel,
  };
}
