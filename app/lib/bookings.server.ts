import { getConfigKV } from "./config.server";

export type BookingStatus = "confirmed" | "simulated" | "failed";

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
