import { format, parseISO, type Locale } from "date-fns";

import type { BookingCutoff } from "./content";

/** Format an ISO date string with a date-fns pattern, optionally localized. */
export function fmtDate(iso: string, pattern: string, locale?: Locale): string {
  return format(parseISO(iso), pattern, locale ? { locale } : undefined);
}

/** Today's calendar date as a YYYY-MM-DD string. */
export function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Longest bookable stay. Bounds per-night work (getCatalogRooms/preparePending
 *  build one entry per night) so a hostile ?checkout=9999-12-31 can't spin the
 *  Worker on millions of iterations — an unauthenticated request-kill otherwise. */
export const MAX_STAY_NIGHTS = 60;

/** Whether a search/stay is bookable: check-in is today or later, check-out is
 *  strictly after check-in, and the stay is within MAX_STAY_NIGHTS. Guards stale
 *  tabs with past dates, inverted ranges, and abusive far-future ranges. Lexical
 *  compare is valid for YYYY-MM-DD strings. */
export function isStayBookable(checkin: string, checkout: string): boolean {
  if (!(checkin >= todayISODate() && checkout > checkin)) return false;
  const nights = Math.round((Date.parse(checkout) - Date.parse(checkin)) / 86400000);
  return nights >= 1 && nights <= MAX_STAY_NIGHTS;
}

/** Current calendar date (YYYY-MM-DD) and minutes-since-midnight in a timezone. */
function localNowParts(tz: string, now: Date): { date: string; minutes: number } {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
    let hour = parseInt(parts.hour, 10);
    if (hour === 24) hour = 0; // some engines emit "24" at midnight
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: hour * 60 + parseInt(parts.minute, 10),
    };
  } catch {
    // Invalid timezone → fall back to UTC.
    const isoStr = now.toISOString();
    return { date: isoStr.slice(0, 10), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() };
  }
}

function addDaysISO(dateISO: string, n: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Parse "HH:MM" to minutes-since-midnight, or null if malformed. */
function parseHHMM(t?: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
}

/** Earliest check-in date (YYYY-MM-DD) bookable right now under the lead-time
 *  cutoff, evaluated in the property's timezone. */
export function earliestCheckinDate(cutoff: BookingCutoff, now: Date = new Date()): string {
  const { date: today, minutes } = localNowParts(cutoff.timezone || "UTC", now);
  if (cutoff.days == null) return today; // no restriction
  if (cutoff.days <= 0) {
    // Same-day allowed until the cutoff time; after it, the floor moves to tomorrow.
    const cut = parseHHMM(cutoff.time);
    return cut != null && minutes >= cut ? addDaysISO(today, 1) : today;
  }
  return addDaysISO(today, cutoff.days); // require N days of lead time
}

/** Whether a check-in is too last-minute to accept right now, per the cutoff. */
export function isTooLastMinute(checkin: string, cutoff: BookingCutoff, now: Date = new Date()): boolean {
  if (cutoff.days == null) return false;
  return checkin < earliestCheckinDate(cutoff, now);
}
