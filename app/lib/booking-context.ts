import { useOutletContext } from "react-router";

import type { PropertyInfo } from "./channex/types";

export interface PropertyOutletContext {
  property: PropertyInfo;
  currency: string;
  hotelName: string;
}

export const useProperty = () => useOutletContext<PropertyOutletContext>();

/** ISO currency code -> symbol for compact display (falls back to code). */
export function currencySymbol(currency: string): string {
  const map: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };
  return map[currency] ?? currency;
}
