// Promotions — client-safe types and pure discount logic. The KV-backed CRUD
// lives in promotions.server.ts.

export type DiscountType = "percent" | "fixed";

export interface Promotion {
  id: string;
  /** Code the guest enters at checkout. Stored normalized (upper, no spaces). */
  code: string;
  /** Internal label for the admin list (optional). */
  name?: string;
  type: DiscountType;
  /** Percent (1–100) or a fixed amount in the property currency. */
  value: number;
  enabled: boolean;
  createdAt: string;
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
