import { useOutletContext } from "react-router";

/** Light property context for the guest pages, sourced from admin settings. */
export interface PropertyContext {
  address?: string;
  phone?: string;
  photos?: { url: string }[];
}

export interface PropertyOutletContext {
  property: PropertyContext;
  currency: string;
  hotelName: string;
  lang: string;
}

export const useProperty = () => useOutletContext<PropertyOutletContext>();

/** ISO currency code -> symbol for compact display (falls back to code). */
export function currencySymbol(currency: string): string {
  const map: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };
  return map[currency] ?? currency;
}
