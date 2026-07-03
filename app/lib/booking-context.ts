import { useOutletContext } from "react-router";

import { DEFAULT_LANG } from "./content";

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

// Fallback for standalone pages that reuse the shared guest components
// (GuestSelector/CalendarPopover) without a property Outlet context — e.g. the
// collection landing. Reading a missing outlet context should degrade, not crash.
const NO_CONTEXT: PropertyOutletContext = {
  property: {},
  currency: "GBP",
  hotelName: "",
  lang: DEFAULT_LANG,
};

export const useProperty = () => useOutletContext<PropertyOutletContext>() ?? NO_CONTEXT;

/** ISO currency code -> symbol for compact display (falls back to code). */
export function currencySymbol(currency: string): string {
  const map: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };
  return map[currency] ?? currency;
}
