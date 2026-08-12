// The one implementation of "what does this stay cost, all-in" and "which
// acknowledgments must the guest give" — shared by the checkout loader, action,
// and component, the confirmation page, and the v1 bookings API. These were
// five hand-copies that drifted twice before being centralised (a wrong
// headcount on confirmation, a page-order-dependent tax base); anything that
// changes the charged amount or the consent gate belongs here, so both sides of
// the server/client boundary move together.
import { parseISO } from "date-fns";

import { cartCoverage, type ResolvedLine } from "./cart";
import { taxableExtrasTotal, untaxedExtrasTotal, type ResolvedExtra } from "./extras";
import { computePricing, type Pricing, type TaxConfig } from "./pricing";
import { policyToCancellation, type CancelAnchor } from "./policy-copy";
import type { CancellationLike } from "./cancellation";
import type { RatePolicy } from "./rate-policy";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface StayTotals {
  pricing: Pricing;
  /** Room subtotal after the discount — the pricing `base`. */
  discountedRoom: number;
  /** The all-in amount the guest pays: taxed total plus untaxed extras on top. */
  grandTotal: number;
  /** Headcount the per-person taxes/fees were priced with (from the resolved lines). */
  adults: number;
  children: number;
}

/**
 * All-in totals for a resolved cart. Per-person taxes count the RESOLVED
 * per-line occupancy — the headcount actually booked — never the searched
 * party; `fallbackParty` applies only while no cart lines have resolved
 * (a confirmation page reloaded without its cart params).
 */
export function stayTotals(
  lines: ResolvedLine[],
  extraLines: ResolvedExtra[],
  stay: { nights: number; checkin?: string; discount?: number },
  taxConfig: TaxConfig,
  fallbackParty?: { adults: number; children: number },
): StayTotals {
  const coverage = cartCoverage(lines);
  const adults = lines.length ? coverage.adults : (fallbackParty?.adults ?? 0);
  const children = lines.length ? coverage.children : (fallbackParty?.children ?? 0);
  const discountedRoom = round2(coverage.total - (stay.discount ?? 0));
  const pricing = computePricing(
    {
      base: discountedRoom,
      nights: stay.nights,
      adults,
      children,
      rooms: lines.length,
      cleaningFee: lines.reduce((s, l) => s + l.cleaningFee, 0),
      taxableExtras: taxableExtrasTotal(extraLines),
      checkin: stay.checkin,
    },
    taxConfig,
  );
  // VAT-exempt extras ride on top of the taxed total untouched.
  const grandTotal = round2(pricing.total + untaxedExtrasTotal(extraLines));
  return { pricing, discountedRoom, grandTotal, adults, children };
}

export interface ConsentGate {
  /** The cancellation snapshot the gate was judged from, for display reuse. */
  cancelInfo: CancellationLike;
  /** A refundable rate whose free-cancellation window already closed is, for
   *  THIS booking, non-refundable — the guest can't go back and cancel free. */
  freeWindowClosed: boolean;
  nonRefundable: boolean;
  /** Money really leaves the card today (not a prepay policy with no payments set up). */
  chargedToday: boolean;
  /** Whether the distinct non-refundable/charged acknowledgment is required. */
  needAck: boolean;
}

/**
 * Which consents this booking needs. The server action rejects on this and the
 * form renders its checkboxes from it, so the two must never be computed
 * separately: a gate the UI didn't show is a booking the guest can't make, and
 * a gate the action didn't check is an acknowledgment that never happened.
 */
export function consentGate(opts: {
  policy: RatePolicy;
  checkin: string;
  anchor?: CancelAnchor;
  /** What's actually collected today, after any gift voucher. */
  dueNow: number;
  /** Whether a card is really taken at checkout (live + Stripe connected). */
  collectsCard: boolean;
  now?: number;
}): ConsentGate {
  const cancelInfo = policyToCancellation(opts.policy, opts.checkin, opts.anchor);
  const freeWindowClosed =
    cancelInfo.refundable &&
    cancelInfo.cancelByISO != null &&
    (opts.now ?? Date.now()) > parseISO(cancelInfo.cancelByISO).getTime();
  const nonRefundable = !opts.policy.cancellation.refundable || freeWindowClosed;
  const chargedToday = opts.collectsCard && opts.dueNow > 0;
  return { cancelInfo, freeWindowClosed, nonRefundable, chargedToday, needAck: nonRefundable || chargedToday };
}
