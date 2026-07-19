// Voucher sales — client-safe types + pure rule logic. Server CRUD (KV catalog
// + D1 sold-voucher ledger) lives in vouchers.server.ts.
//
// Two kinds:
// - "gift":    a monetary voucher (buy £100 of value), redeemed against the
//              amount due at checkout; balance-based, partial redemption.
// - "package": a bookable stay package ("Weekend Getaway — 2 nights for 2"),
//              redeemed by BOOKING ONLINE under the hotel's rules (stay window,
//              blocked dates, allowed check-in weekdays, allowed room types).

export type VoucherKind = "gift" | "package";

export interface PackageRules {
  /** Length of the stay, in nights. */
  nights: number;
  adults: number;
  children?: number;
  /** Room types the package can be redeemed against. */
  roomIds: string[];
  /** Bookable stay window (inclusive check-in bounds); either side open. */
  window?: { from?: string; to?: string };
  /** Date ranges (inclusive) where check-in is not allowed, e.g. peak season. */
  blockedRanges: { from: string; to: string }[];
  /** Allowed check-in weekdays, 0 (Sun) – 6 (Sat). Empty = any day. */
  checkinDays: number[];
}

export interface VoucherProduct {
  id: string;
  kind: VoucherKind;
  active: boolean;
  position: number;
  createdAt: string;
  title: string;
  description?: string;
  /** /images/… path (R2). */
  image?: string;
  /** Sale price, in the property currency. */
  price: number;
  /** Gift vouchers: face value (defaults to price when unset). */
  value?: number;
  /** Validity after purchase, in months. */
  expiresMonths: number;
  /** Max sellable (STAAH "sale counter"); unset = unlimited. */
  cap?: number;
  terms?: string;
  /** "What's included" bullet points shown on the gift page, one per entry. */
  included?: string[];
  /** Package rules; present iff kind === "package". */
  package?: PackageRules;
}

/** The product details frozen onto a sold voucher at purchase time, so later
 *  edits to the catalog can't change what a buyer already paid for. */
export interface VoucherProductSnapshot {
  title: string;
  description?: string;
  image?: string;
  price: number;
  value?: number;
  terms?: string;
  included?: string[];
  package?: PackageRules;
  /** Display names of the package's allowed room types, resolved at purchase. */
  roomTitles?: string[];
}

export type VoucherStatus = "active" | "redeemed" | "cancelled";

export interface VoucherRedemption {
  at: string;
  /** Gift vouchers: amount applied. */
  amount?: number;
  /** Booking the redemption paid for (once finalized). */
  bookingId?: string;
  /** Booking reference for a pending checkout hold (gift vouchers). */
  ref?: string;
  /** Pending hold expiry — after this the hold no longer counts against the
   *  balance (checkout was abandoned). */
  pendingUntil?: string;
  /** Admin email for manual (desk/phone) redemptions or adjustments. */
  by?: string;
  note?: string;
}

export interface VoucherRecord {
  id: string;
  /** The guest-facing code — also the URL credential for the voucher page. */
  code: string;
  kind: VoucherKind;
  productId: string;
  product: VoucherProductSnapshot;
  buyer: { name: string; email: string };
  /** Present when bought as a gift. */
  gift?: { recipientName: string; recipientEmail?: string; message?: string };
  purchasedAt: string;
  expiresAt: string;
  status: VoucherStatus; // "expired" is derived at read time, never stored
  /** Gift vouchers: remaining value (before subtracting pending holds). */
  balance?: number;
  redemptions: VoucherRedemption[];
  /** Stripe payment captured at purchase; absent on simulated/comp vouchers. */
  payment?: {
    provider: string;
    accountId?: string;
    sessionId?: string;
    paymentIntentId?: string;
    amount?: number;
    currency?: string;
    /** Set once the charge has been refunded. `by` is the admin who issued it,
     *  or a "buyer …" marker for cooling-off self-cancellations. */
    refund?: { id: string; amount: number; currency?: string; at: string; by?: string };
  };
  /** Complimentary — issued free by the hotel. */
  comp?: boolean;
  /** Test-mode purchase (no real payment). */
  simulated?: boolean;
}

// ---------- codes ----------

/** Crockford-ish alphabet: no 0/O/1/I/L so codes survive handwriting/phone. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Generate a voucher code like "RP-7K2M-9QX4" (~1e12 space — unguessable
 *  enough to be the voucher-page credential, like review/booking links). */
export function voucherCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `RP-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Normalize user-typed codes: uppercase, strip spaces; hyphens optional. */
export function normalizeVoucherCode(input: string): string {
  const raw = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!raw.startsWith("RP") || raw.length !== 10) return input.trim().toUpperCase();
  return `RP-${raw.slice(2, 6)}-${raw.slice(6)}`;
}

// ---------- validity / rules (pure, unit-tested) ----------

/** Expiry = purchase instant + N months (calendar-safe: Jan 31 + 1mo → Feb 28/29). */
export function computeExpiry(purchasedAtISO: string, months: number): string {
  const d = new Date(purchasedAtISO);
  const targetMonth = d.getUTCMonth() + months;
  const end = new Date(d);
  end.setUTCMonth(targetMonth);
  // JS overflows (Jan 31 + 1mo = Mar 3) — clamp back to the last day of the month.
  if (end.getUTCMonth() !== ((targetMonth % 12) + 12) % 12) end.setUTCDate(0);
  return end.toISOString();
}

export function isExpired(v: Pick<VoucherRecord, "expiresAt">, now = Date.now()): boolean {
  const t = Date.parse(v.expiresAt);
  return Number.isFinite(t) && now > t;
}

const inRange = (date: string, from: string, to: string) => date >= from && date <= to;

/** Why a check-in date is not allowed (null = allowed). Expiry is checked
 *  separately against the voucher; this validates the PRODUCT rules only. */
export function checkinDisallowedReason(
  pkg: PackageRules,
  checkinISO: string,
  todayISO: string,
): "past" | "window" | "blocked" | "weekday" | null {
  if (checkinISO < todayISO) return "past";
  if (pkg.window?.from && checkinISO < pkg.window.from) return "window";
  if (pkg.window?.to && checkinISO > pkg.window.to) return "window";
  if (pkg.blockedRanges.some((r) => inRange(checkinISO, r.from, r.to))) return "blocked";
  if (pkg.checkinDays.length > 0) {
    // Parse as UTC noon to avoid TZ day-shift; getUTCDay: 0=Sun … 6=Sat.
    const dow = new Date(`${checkinISO}T12:00:00Z`).getUTCDay();
    if (!pkg.checkinDays.includes(dow)) return "weekday";
  }
  return null;
}

export function isCheckinAllowed(pkg: PackageRules, checkinISO: string, todayISO: string): boolean {
  return checkinDisallowedReason(pkg, checkinISO, todayISO) === null;
}

/** Remaining spendable value on a gift voucher: stored balance minus live
 *  pending checkout holds (expired holds no longer count). */
export function giftBalance(v: VoucherRecord, now = Date.now()): number {
  if (v.kind !== "gift") return 0;
  const held = v.redemptions
    .filter((r) => r.pendingUntil && !r.bookingId && Date.parse(r.pendingUntil) > now)
    .reduce((s, r) => s + (r.amount ?? 0), 0);
  return Math.max(0, Math.round(((v.balance ?? 0) - held) * 100) / 100);
}

/** Derived display status (adds "expired" and gift "used up" to the stored one). */
export function displayStatus(v: VoucherRecord, now = Date.now()): VoucherStatus | "expired" {
  if (v.status !== "active") return v.status;
  if (isExpired(v, now)) return "expired";
  return "active";
}

// ---------- buyer self-service (cooling-off cancellation) ----------

/** Default cancel-for-refund window after purchase (EU distance-selling norm).
 *  Properties can override per-property; 0 disables self-cancel entirely. */
export const DEFAULT_COOLING_OFF_DAYS = 14;

/** End of the cooling-off window, as epoch ms. */
export function coolingOffEndsAt(v: VoucherRecord, coolingOffDays: number): number {
  return Date.parse(v.purchasedAt) + coolingOffDays * 86_400_000;
}

/** Why the BUYER may not self-cancel for a refund right now — or null when the
 *  cancel is allowed. "status" = not active any more; "spent" = some value was
 *  already redeemed or is held by a checkout in flight; "window" = self-cancel
 *  is disabled or the cooling-off period has passed. */
export function selfCancelDisallowedReason(
  v: VoucherRecord,
  coolingOffDays: number,
  now = Date.now(),
): "status" | "spent" | "window" | null {
  if (displayStatus(v, now) !== "active") return "status";
  if (v.redemptions.some((r) => r.bookingId)) return "spent";
  if (v.kind === "gift" && giftBalance(v, now) < (v.product.value ?? v.product.price)) return "spent";
  if (coolingOffDays <= 0 || now > coolingOffEndsAt(v, coolingOffDays)) return "window";
  return null;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
