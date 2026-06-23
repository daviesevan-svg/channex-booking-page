import type { RatePlan } from "./channex/types";

export interface StayPricing {
  total: number;
  net: number;
  taxes: number;
  perNight: number;
}

/** Derive the price breakdown for a rate plan over the stay.
 *  Channex totalPrice is gross (incl. inclusive taxes); netPrice is pre-tax. */
export function priceStay(rate: RatePlan, nights: number): StayPricing {
  const total = Number(rate.totalPrice);
  const net = Number(rate.netPrice ?? rate.totalPrice);
  const taxes = Math.max(0, total - net);
  const perNight = nights > 0 ? net / nights : net;
  return { total, net, taxes, perNight };
}
