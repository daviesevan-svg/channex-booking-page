import type { CancellationSnapshot } from "./policy.server";
import type { AppliedPromo } from "./promotions";
import { getConfigKV } from "./config.server";

export type BookingStatus = "confirmed" | "simulated" | "failed";
export type BookingLifecycle = "active" | "cancelled";

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
  /** Where the booking is in its life: active or cancelled. Defaults to active. */
  lifecycle?: BookingLifecycle;
  cancelledAt?: string;
  /** Cancellation policy resolved at booking time (drives the guest cancel button). */
  cancellation?: CancellationSnapshot;
  /** Promo code applied at checkout, if any. `total` is the post-discount total. */
  promo?: AppliedPromo;
  createdAt: string;
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
