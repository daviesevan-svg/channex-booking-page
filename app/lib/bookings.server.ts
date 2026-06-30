import { addDays, format, parseISO } from "date-fns";

import type { CancellationSnapshot } from "./policy.server";
import type { AppliedPromo } from "./promotions";
import type { ResolvedExtra } from "./extras";
import { getConfigKV } from "./config.server";

/** Per-(room, night) availability units a stay occupies — for decrement on
 *  booking and restore on cancel. */
export function stayAvailabilityItems(
  rooms: { roomId: string }[],
  checkin: string,
  nights: number,
): { roomId: string; date: string; by: number }[] {
  const dates = Array.from({ length: Math.max(1, nights) }, (_, i) =>
    format(addDays(parseISO(checkin), i), "yyyy-MM-dd"),
  );
  const byRoom = new Map<string, number>();
  for (const r of rooms) byRoom.set(r.roomId, (byRoom.get(r.roomId) ?? 0) + 1);
  return [...byRoom].flatMap(([roomId, by]) => dates.map((date) => ({ roomId, date, by })));
}

export type BookingStatus = "confirmed" | "simulated" | "failed";
export type BookingLifecycle = "active" | "cancelled";

/** Stripe payment outcome stored on a booking. `mode:"payment"` = a charge was
 *  taken (deposit/prepay); `mode:"setup"` = a guarantee card saved on file. */
export interface PaymentInfo {
  provider: "stripe";
  mode: "payment" | "setup";
  /** Connected Stripe account the charge/setup ran on. */
  accountId: string;
  sessionId: string;
  /** Amount captured in major units (mode: payment). */
  amount?: number;
  currency?: string;
  paymentIntentId?: string;
  /** Guarantee card on file (mode: setup) — for charging a no-show later. */
  customerId?: string;
  paymentMethodId?: string;
  cardLast4?: string;
  cardBrand?: string;
  /** Set once the charge has been refunded (full or partial). `by` is the admin
   *  who issued it, or an "auto …" marker for automatic refunds. */
  refund?: { id: string; amount: number; currency?: string; at: string; by?: string };
}

export interface BookingRoom {
  roomId: string;
  roomTitle: string;
  rateId: string;
  rateTitle: string;
  adults: number;
  children: number;
  total: number;
}

export interface BookingRecord {
  /** Internal record id (URL + storage key) — stable even if Channex returns no id. */
  id: string;
  /** Guest-facing reference shown on the confirmation page. */
  reference: string;
  /** Channex reservation id, when the booking was pushed live. */
  channexId?: string;
  status: BookingStatus;
  /** Failure reason from Channex, when status is "failed". */
  error?: string;
  /** The Open Channel payload, stored only while status is "failed" so an admin
   *  can retry the exact push. Cleared once the booking succeeds. */
  channexPayload?: unknown;
  /** Where the booking is in its life: active or cancelled. Defaults to active. */
  lifecycle?: BookingLifecycle;
  cancelledAt?: string;
  /** Who cancelled: an admin email for a manual cancel; unset = guest self-cancel. */
  cancelledBy?: string;
  /** Cancellation policy resolved at booking time (drives the guest cancel button). */
  cancellation?: CancellationSnapshot;
  /** Promo code applied at checkout, if any. `total` is the post-discount total. */
  promo?: AppliedPromo;
  /** Automatic offer baked into the room prices for this stay, if any. */
  offer?: AppliedPromo;
  /** True once the booking has decremented inventory (so cancel restores it once). */
  inventoryHeld?: boolean;
  createdAt: string;
  /** Guest's language at booking time — drives confirmation/cancellation email
   *  language. Absent on legacy bookings (falls back to the default). */
  lang?: string;
  currency: string;
  checkin: string;
  checkout: string;
  nights: number;
  total: number;
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    arrival?: string;
    requests?: string;
  };
  rooms: BookingRoom[];
  /** Stripe payment captured at checkout, or a guarantee card saved on file. */
  payment?: PaymentInfo;
  /** Extras ("Enhance your stay") purchased, priced at booking time. */
  extras?: ResolvedExtra[];
  /** Consent captured at checkout — the defence for disputes/chargebacks. */
  consent?: {
    acceptedAt: string;
    ip?: string;
    userAgent?: string;
    /** The exact policy text shown to the guest when they agreed. */
    policyText: string[];
    /** Amount the guest acknowledged as due today. */
    dueNow?: number;
    /** Distinct acknowledgment ticked for non-refundable / charged-today rates. */
    nonRefundableAck?: boolean;
    marketingOptIn: boolean;
  };
}

const bookingsKey = (pid: string) => `bookings:${pid}`;
const MAX_RECORDS = 500;

// Crockford base32 (no I/L/O/U) — unambiguous when read aloud or typed.
const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A high-entropy booking reference. This doubles as the guest's "manage my
 *  booking" credential, so it must be unguessable — never derive it from the
 *  clock or a constant. 8 chars of base32 ≈ 40 bits. (256 % 32 === 0, so the
 *  modulo below is unbiased.) */
export function generateReference(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += REF_ALPHABET[b % 32];
  return out;
}

export async function getBookings(pid: string): Promise<BookingRecord[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(bookingsKey(pid));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as BookingRecord[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function getBooking(pid: string, id: string): Promise<BookingRecord | undefined> {
  return (await getBookings(pid)).find((b) => b.id === id);
}

const norm = (s: string) => s.trim().toLowerCase();

/** All bookings made with a given email (newest first). */
export async function getBookingsByEmail(pid: string, email: string): Promise<BookingRecord[]> {
  const e = norm(email);
  return (await getBookings(pid)).filter((b) => norm(b.guest.email) === e);
}

/** Airline-style lookup: a booking matching both reference and email. */
export async function findBookingByRefAndEmail(
  pid: string,
  reference: string,
  email: string,
): Promise<BookingRecord | undefined> {
  const ref = norm(reference);
  const e = norm(email);
  return (await getBookings(pid)).find(
    (b) => norm(b.reference) === ref && norm(b.guest.email) === e,
  );
}

/** Prepend a booking record (newest first), capped to the most recent MAX_RECORDS. */
export async function recordBooking(pid: string, record: BookingRecord): Promise<void> {
  const kv = getConfigKV();
  if (!kv) return;
  const arr = await getBookings(pid);
  arr.unshift(record);
  if (arr.length > MAX_RECORDS) arr.length = MAX_RECORDS;
  await kv.put(bookingsKey(pid), JSON.stringify(arr));
}

/** Patch a stored booking by id. Returns the updated record, or undefined. */
export async function updateBooking(
  pid: string,
  id: string,
  patch: Partial<BookingRecord>,
): Promise<BookingRecord | undefined> {
  const kv = getConfigKV();
  if (!kv) return undefined;
  const arr = await getBookings(pid);
  const i = arr.findIndex((b) => b.id === id);
  if (i === -1) return undefined;
  arr[i] = { ...arr[i], ...patch };
  await kv.put(bookingsKey(pid), JSON.stringify(arr));
  return arr[i];
}
