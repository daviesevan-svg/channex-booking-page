// Online redemption of a PACKAGE voucher — the standout of the voucher
// feature: the guest books their prepaid stay themselves, under the hotel's
// rules (window, blocked dates, check-in weekdays, allowed room types),
// against live availability. No phone call.
//
// Concurrency: the voucher is flipped active → redeemed with an optimistic CAS
// *before* the booking is created, so two simultaneous redemption attempts
// can't both book. The booking then follows the same success path as a normal
// finalize (claim, Channex push, inventory decrement, emails, webhook).
import { addDays, format, parseISO } from "date-fns";

import { checkinDisallowedReason, isExpired, type PackageRules, type VoucherRecord } from "./vouchers";
import { casUpdateVoucher } from "./vouchers.server";
import {
  claimBooking,
  generateReference,
  stayAvailabilityItems,
  updateBooking,
  type BookingRecord,
} from "./bookings.server";
import { availabilityShortfall, decrementAvailability, getInventory } from "./ari.server";
import { getRates, getRooms, rateChannexId } from "./catalog.server";
import { getSettings } from "./overrides.server";
import { getConfig } from "./config.server";
import { pushOpenChannelBooking } from "./open-channel.server";
import { sendBookingEmails } from "./email.server";
import { dispatchWebhook } from "./webhooks.server";
import { serializeBooking } from "./api-serialize";

const iso = (d: Date) => format(d, "yyyy-MM-dd");

export interface CheckinOption {
  date: string;
  /** Allowed room types with inventory for every night of the stay. */
  roomIds: string[];
}

/** The next bookable check-in dates for a package: rule-allowed AND with
 *  inventory in at least one allowed room type for every night. Bounded to a
 *  6-month scan (or the window/expiry end if sooner) and `limit` results. */
export async function packageCheckinOptions(
  pid: string,
  pkg: PackageRules,
  expiresAt: string,
  limit = 24,
): Promise<CheckinOption[]> {
  const today = new Date();
  const start = pkg.window?.from && pkg.window.from > iso(today) ? parseISO(pkg.window.from) : today;
  let end = addDays(today, 183);
  const expiry = parseISO(expiresAt.slice(0, 10));
  if (expiry < end) end = expiry;
  if (pkg.window?.to && parseISO(pkg.window.to) < end) end = parseISO(pkg.window.to);
  if (end < start) return [];

  const inv = await getInventory(pid, iso(start), iso(addDays(end, pkg.nights)));
  const todayISO = iso(today);
  const options: CheckinOption[] = [];
  for (let d = start; d <= end && options.length < limit; d = addDays(d, 1)) {
    const date = iso(d);
    if (checkinDisallowedReason(pkg, date, todayISO) !== null) continue;
    const roomIds = pkg.roomIds.filter((roomId) => {
      for (let n = 0; n < pkg.nights; n++) {
        if ((inv.availability[`${roomId}|${iso(addDays(d, n))}`] ?? 0) <= 0) return false;
      }
      return true;
    });
    if (roomIds.length > 0) options.push({ date, roomIds });
  }
  return options;
}

export interface RedeemInput {
  pid: string;
  voucher: VoucherRecord;
  checkin: string;
  roomId: string;
  guest: { firstName: string; lastName: string; email: string; phone: string; requests?: string };
  origin: string;
  lang?: string;
}

export type RedeemResult =
  | { ok: true; booking: BookingRecord }
  | { ok: false; reason: "invalid" | "rules" | "unavailable" | "conflict"; message: string };

/** Redeem a package voucher into a real booking. Server-side re-validation of
 *  every rule, CAS-first redemption, then the standard booking side effects. */
export async function redeemPackageVoucher(input: RedeemInput): Promise<RedeemResult> {
  const { pid, voucher: v, checkin, roomId, guest } = input;
  const pkg = v.product.package;
  if (v.kind !== "package" || !pkg) return { ok: false, reason: "invalid", message: "Not a package voucher." };
  if (v.status !== "active") return { ok: false, reason: "invalid", message: "This voucher has already been used or cancelled." };
  if (isExpired(v)) return { ok: false, reason: "invalid", message: "This voucher has expired." };
  if (!pkg.roomIds.includes(roomId)) return { ok: false, reason: "rules", message: "That room type isn't part of this package." };
  const todayISO = iso(new Date());
  if (checkinDisallowedReason(pkg, checkin, todayISO) !== null) {
    return { ok: false, reason: "rules", message: "That check-in date isn't allowed by this package." };
  }

  const checkout = iso(addDays(parseISO(checkin), pkg.nights));
  const [rooms, rates, settings] = await Promise.all([getRooms(pid), getRates(pid), getSettings(pid)]);
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return { ok: false, reason: "invalid", message: "That room no longer exists." };

  const bookingRooms = [
    {
      roomId,
      roomTitle: room.title,
      // First active rate priced for this room — Channex needs a mapped rate
      // plan code; the rate's own price is irrelevant (the package sets it).
      rateId: rates.find((r) => r.active && r.prices[roomId] != null)?.id ?? rates[0]?.id ?? "voucher",
      rateTitle: v.product.title,
      adults: pkg.adults,
      children: pkg.children ?? 0,
      total: v.product.price,
    },
  ];
  const items = stayAvailabilityItems(bookingRooms, checkin, pkg.nights);
  if (await availabilityShortfall(pid, items)) {
    return { ok: false, reason: "unavailable", message: "Those dates just sold out — please pick another date." };
  }

  const config = getConfig();
  const live = Boolean(settings.liveBooking ?? config.allowLiveBooking) && settings.connectedSystem === "channex";
  const reference = generateReference();
  const bookingId = crypto.randomUUID();
  const now = new Date().toISOString();

  // CAS-first: whoever flips the voucher owns the booking. A concurrent
  // redemption (double-click, shared code) loses cleanly here.
  const redeemed = await casUpdateVoucher(pid, v, {
    ...v,
    status: "redeemed",
    redemptions: [...v.redemptions, { at: now, bookingId }],
  });
  if (!redeemed) {
    return { ok: false, reason: "conflict", message: "This voucher was just redeemed — refresh to see its status." };
  }

  const rateId = bookingRooms[0].rateId;
  const rate = rates.find((r) => r.id === rateId);
  const nights = pkg.nights;
  const per = Math.round((v.product.price / nights) * 100) / 100;
  const stayDates = Array.from({ length: nights }, (_, i) => iso(addDays(parseISO(checkin), i)));
  const channexPayload = {
    status: "new",
    provider_code: config.providerCode,
    hotel_code: pid,
    ota_name: config.providerCode || "Direct",
    reservation_id: reference,
    currency: settings.currency || "GBP",
    arrival_date: checkin,
    departure_date: checkout,
    customer: { name: guest.firstName, surname: guest.lastName, mail: guest.email, phone: guest.phone },
    // The package price spread across the nights (last night absorbs rounding),
    // so the PMS sees the real value — the money arrived at voucher purchase.
    notes: `Paid with gift voucher ${v.code} — ${v.product.title}`,
    rooms: [
      {
        index: 0,
        room_type_code: roomId,
        occupancy: { adults: pkg.adults, children: pkg.children ?? 0, infants: 0 },
        guests: [{ name: guest.firstName, surname: guest.lastName }],
        days: stayDates.map((date, i) => ({
          date,
          price: (i === nights - 1 ? Math.round((v.product.price - per * (nights - 1)) * 100) / 100 : per).toFixed(2),
          rate_plan_code: rate ? rateChannexId(rate, roomId) : rateId,
        })),
      },
    ],
  };

  const provisional: BookingRecord = {
    id: bookingId,
    reference,
    status: "simulated",
    lifecycle: "active",
    createdAt: now,
    lang: input.lang,
    currency: settings.currency || "GBP",
    checkin,
    checkout,
    nights,
    total: v.product.price,
    // A redeemed package is spent — the portal must not offer a cash refund.
    cancellation: { refundable: false, cancelByISO: null },
    guest: { ...guest, requests: guest.requests || undefined },
    rooms: bookingRooms,
    voucher: { code: v.code, title: v.product.title },
    payment: { provider: "voucher", mode: "payment", accountId: "", sessionId: "", amount: v.product.price, currency: settings.currency || "GBP" },
    inventoryHeld: false,
  };
  const claim = await claimBooking(pid, provisional);
  if (!claim.won) return { ok: true, booking: claim.existing ?? provisional };

  let status: BookingRecord["status"] = "simulated";
  let channexId: string | undefined;
  let error: string | undefined;
  if (live) {
    try {
      const result = (await pushOpenChannelBooking(channexPayload)) as { reservation_id?: string; id?: string } | undefined;
      channexId = result?.reservation_id || result?.id || undefined;
      status = "confirmed";
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : "Channex rejected the booking.";
    }
  }
  const patch: Partial<BookingRecord> = {
    status,
    channexId,
    error,
    channexPayload,
    inventoryHeld: status !== "failed",
  };
  const booking: BookingRecord = (await updateBooking(pid, bookingId, patch)) ?? { ...provisional, ...patch };

  if (status !== "failed") {
    await decrementAvailability(pid, items);
    await sendBookingEmails(pid, booking, input.origin);
    await dispatchWebhook(pid, "booking.created", serializeBooking(booking), Date.now());
  }
  // On a failed push the voucher stays redeemed + linked: the booking exists
  // with a Retry button in admin, exactly like a failed paid booking.
  return { ok: true, booking };
}
