import { format, parseISO, type Locale } from "date-fns";

/** Format an ISO date string with a date-fns pattern, optionally localized. */
export function fmtDate(iso: string, pattern: string, locale?: Locale): string {
  return format(parseISO(iso), pattern, locale ? { locale } : undefined);
}
