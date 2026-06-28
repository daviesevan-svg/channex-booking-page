import { format, parseISO, type Locale } from "date-fns";

/** Format an ISO date string with a date-fns pattern, optionally localized. */
export function fmtDate(iso: string, pattern: string, locale?: Locale): string {
  return format(parseISO(iso), pattern, locale ? { locale } : undefined);
}

/** Today's calendar date as a YYYY-MM-DD string. */
export function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Whether a search/stay is bookable: check-in is today or later and check-out
 *  is strictly after check-in. Guards against stale tabs with past dates (and
 *  inverted ranges). Lexical compare is valid for YYYY-MM-DD strings. */
export function isStayBookable(checkin: string, checkout: string): boolean {
  return checkin >= todayISODate() && checkout > checkin;
}
