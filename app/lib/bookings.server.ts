import { addDays, format, parseISO } from "date-fns";

import type { CancellationSnapshot } from "./policy.server";
import type { AppliedPromo } from "./promotions";
import type { ResolvedExtra } from "./extras";
import { getConfigKV, getDB } from "./config.server";

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
  /** Taxes & fees breakdown snapshotted at booking time — the amounts charged on
   *  top of the room prices (fees, city tax, cleaning, on-top VAT) plus the VAT
   *  share already inside inclusive prices. Absent on legacy bookings. */
  pricing?: {
    charges: { label: string; amount: number }[];
    taxLines: { label: string; amount: number }[];
    taxIncluded: number;
  };
  /** True once the booking has decremented inventory (so cancel restores it once). */
  inventoryHeld?: boolean;
  /** Review-request emails sent so far (max 3; stops once a review exists). */
  reviewRequests?: { count: number; lastAt: string };
  /** Admin edits to guest details, oldest first — an audit trail, so the record
   *  as consented at checkout stays reconstructible (dispute defence). */
  edits?: {
    at: string;
    /** Admin email who made the edit. */
    by?: string;
    changes: { field: string; from: string; to: string }[];
  }[];
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

// Bookings live in D1 (atomic writes + immediate consistency), NOT a single KV
// key. The old KV list was read-modify-write, so concurrent finalizes (the
// Stripe return URL and the webhook) could double-write or lose a paid record.
// D1 lets us claim a reference atomically = finalize-once (see claimBooking).
const bookingsKey = (pid: string) => `bookings:${pid}`;

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

let schemaReady = false;
async function ensureBookingSchema(): Promise<void> {
  if (schemaReady) return;
  await db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS booking (
        pid TEXT NOT NULL, id TEXT NOT NULL, reference TEXT NOT NULL,
        email TEXT NOT NULL, created_at TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'active', json TEXT NOT NULL,
        PRIMARY KEY (pid, id)
      )`,
    )
    .run();
  await db()
    .prepare(`CREATE UNIQUE INDEX IF NOT EXISTS booking_ref ON booking(pid, reference)`)
    .run();
  await db().prepare(`CREATE INDEX IF NOT EXISTS booking_email ON booking(pid, email)`).run();
  schemaReady = true;
}

type Row = { json: string };
const parseRows = (rows: Row[]): BookingRecord[] =>
  rows.map((r) => JSON.parse(r.json) as BookingRecord);

/** The indexed columns extracted from a record (the full record is stored as JSON). */
function rowValues(pid: string, r: BookingRecord): [string, string, string, string, string, string, string] {
  return [pid, r.id, r.reference, norm(r.guest.email), r.createdAt, r.lifecycle ?? "active", JSON.stringify(r)];
}

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

const norm = (s: string) => s.trim().toLowerCase();

// One-time backfill of any legacy KV bookings into D1, per property per isolate.
const migrated = new Set<string>();
async function migrateFromKv(pid: string): Promise<void> {
  if (migrated.has(pid)) return;
  migrated.add(pid);
  const kv = getConfigKV();
  if (!kv) return;
  const raw = await kv.get(bookingsKey(pid));
  if (!raw) return;
  try {
    const arr = JSON.parse(raw) as BookingRecord[];
    if (Array.isArray(arr) && arr.length) {
      const stmt = db().prepare(
        `INSERT INTO booking (pid,id,reference,email,created_at,lifecycle,json)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      );
      const binds = arr.map((r) => stmt.bind(...rowValues(pid, r)));
      for (let i = 0; i < binds.length; i += 100) await db().batch(binds.slice(i, i + 100));
    }
    await kv.delete(bookingsKey(pid)); // migrated — D1 is now authoritative
  } catch {
    migrated.delete(pid); // let a later call retry
  }
}

/** Schema + legacy migration guard run before every op. */
async function ready(pid: string): Promise<void> {
  await ensureBookingSchema();
  await migrateFromKv(pid);
}

export async function getBookings(pid: string): Promise<BookingRecord[]> {
  await ready(pid);
  const { results } = await db()
    .prepare(`SELECT json FROM booking WHERE pid=? ORDER BY created_at DESC, rowid DESC`)
    .bind(pid)
    .all<Row>();
  return parseRows(results ?? []);
}

export async function getBooking(pid: string, id: string): Promise<BookingRecord | undefined> {
  await ready(pid);
  const row = await db().prepare(`SELECT json FROM booking WHERE pid=? AND id=?`).bind(pid, id).first<Row>();
  return row ? (JSON.parse(row.json) as BookingRecord) : undefined;
}

/** All bookings made with a given email (newest first). */
export async function getBookingsByEmail(pid: string, email: string): Promise<BookingRecord[]> {
  await ready(pid);
  const { results } = await db()
    .prepare(`SELECT json FROM booking WHERE pid=? AND email=? ORDER BY created_at DESC, rowid DESC`)
    .bind(pid, norm(email))
    .all<Row>();
  return parseRows(results ?? []);
}

/** Airline-style lookup: a booking matching both reference and email. */
export async function findBookingByRefAndEmail(
  pid: string,
  reference: string,
  email: string,
): Promise<BookingRecord | undefined> {
  await ready(pid);
  // References are uppercase base32; match case-insensitively via the stored form.
  const row = await db()
    .prepare(`SELECT json FROM booking WHERE pid=? AND reference=? AND email=?`)
    .bind(pid, reference.trim().toUpperCase(), norm(email))
    .first<Row>();
  return row ? (JSON.parse(row.json) as BookingRecord) : undefined;
}

/** Insert a booking. Overwrites any existing row with the same id (upsert). */
export async function recordBooking(pid: string, record: BookingRecord): Promise<void> {
  await ready(pid);
  await db()
    .prepare(
      `INSERT INTO booking (pid,id,reference,email,created_at,lifecycle,json)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(pid,id) DO UPDATE SET
         reference=excluded.reference, email=excluded.email, created_at=excluded.created_at,
         lifecycle=excluded.lifecycle, json=excluded.json`,
    )
    .bind(...rowValues(pid, record))
    .run();
}

/** Atomically claim a booking's reference. INSERTs the record iff no booking with
 *  that reference exists yet, returning whether we won. This is the finalize-once
 *  latch: only the winner runs the side effects (Channex push, inventory, email),
 *  so the Stripe return URL and webhook can both call finalize safely. */
export async function claimBooking(
  pid: string,
  record: BookingRecord,
): Promise<{ won: true } | { won: false; existing: BookingRecord | undefined }> {
  await ready(pid);
  const res = await db()
    .prepare(
      `INSERT INTO booking (pid,id,reference,email,created_at,lifecycle,json)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    )
    .bind(...rowValues(pid, record))
    .run();
  if (res.meta.changes === 1) return { won: true };
  const existing = await db()
    .prepare(`SELECT json FROM booking WHERE pid=? AND reference=?`)
    .bind(pid, record.reference)
    .first<Row>();
  return { won: false, existing: existing ? (JSON.parse(existing.json) as BookingRecord) : undefined };
}

/** Patch a stored booking by id. Returns the updated record, or undefined. */
export async function updateBooking(
  pid: string,
  id: string,
  patch: Partial<BookingRecord>,
): Promise<BookingRecord | undefined> {
  await ready(pid);
  const current = await getBooking(pid, id);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  await db()
    .prepare(
      `UPDATE booking SET reference=?, email=?, created_at=?, lifecycle=?, json=? WHERE pid=? AND id=?`,
    )
    .bind(next.reference, norm(next.guest.email), next.createdAt, next.lifecycle ?? "active", JSON.stringify(next), pid, id)
    .run();
  return next;
}
