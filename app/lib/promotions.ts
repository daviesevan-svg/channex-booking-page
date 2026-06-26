// Promotions — client-safe types and pure discount logic. The KV-backed CRUD
// lives in promotions.server.ts.
//
// Two kinds, both stored as a Promotion:
//  - trigger "code": the guest types a code at checkout (percent or fixed off).
//  - trigger "auto": a rule-based offer that applies with no code when its
//    conditions match the stay (e.g. "book 60+ days ahead → 10% off"). Auto
//    offers are percent-only so the discount can be shown per-room while
//    browsing, and the % is baked into rate prices in getCatalogRooms.

export type DiscountType = "percent" | "fixed";
export type PromoTrigger = "code" | "auto";

/** Conditions for an automatic offer. All present conditions must hold (AND). */
export interface PromoConditions {
  /** Early bird: book at least this many days before check-in. */
  minDaysAhead?: number;
  /** Last minute: book at most this many days before check-in. */
  maxDaysAhead?: number;
  /** Length of stay: the stay is at least this many nights. */
  minNights?: number;
}

export interface Promotion {
  id: string;
  /** "code" = guest enters a code; "auto" = applies by rules, no code. */
  trigger: PromoTrigger;
  /** Code the guest enters (code promos only). Stored normalized; "" for auto. */
  code: string;
  /** Public label for auto offers (shown to guests); internal note for codes. */
  name?: string;
  /** Rules for an auto offer (ignored for code promos). */
  conditions?: PromoConditions;
  type: DiscountType;
  /** Percent (1–100) or a fixed amount in the property currency. */
  value: number;
  enabled: boolean;
  createdAt: string;
}

/** A promotion resolved and applied to a booking. Snapshotted onto the booking
 *  record so the discount is stable after the fact. A code promo carries `code`;
 *  an automatic offer carries `name`. */
export interface AppliedPromo {
  code?: string;
  name?: string;
  type: DiscountType;
  value: number;
  /** The discount amount in the booking currency. */
  discount: number;
}

/** The stay facts an automatic offer's conditions are evaluated against. */
export interface StayContext {
  /** Whole days between the booking date and check-in (lead time). */
  daysAhead: number;
  /** Number of nights in the stay. */
  nights: number;
}

/** Codes are matched case- and whitespace-insensitively. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

/** The discount amount for a given subtotal — never negative, never more than
 *  the subtotal. Rounded to 2dp. Returns 0 for a disabled promo. */
export function computeDiscount(promo: Promotion, subtotal: number): number {
  if (!promo.enabled || subtotal <= 0) return 0;
  const raw = promo.type === "percent" ? subtotal * (promo.value / 100) : promo.value;
  const capped = Math.min(Math.max(raw, 0), subtotal);
  return Math.round(capped * 100) / 100;
}

/** Whether an automatic offer applies to a stay. */
export function offerMatches(p: Promotion, ctx: StayContext): boolean {
  if (!p.enabled || p.trigger !== "auto" || p.type !== "percent" || p.value <= 0) return false;
  const c = p.conditions ?? {};
  if (c.minDaysAhead != null && ctx.daysAhead < c.minDaysAhead) return false;
  if (c.maxDaysAhead != null && ctx.daysAhead > c.maxDaysAhead) return false;
  if (c.minNights != null && ctx.nights < c.minNights) return false;
  return true;
}

/** The single best automatic offer (highest percent) for a stay, or null. When
 *  several qualify the guest gets the biggest discount. */
export function bestAutoOffer(promos: Promotion[], ctx: StayContext): Promotion | null {
  let best: Promotion | null = null;
  for (const p of promos) {
    if (offerMatches(p, ctx) && (!best || p.value > best.value)) best = p;
  }
  return best;
}
