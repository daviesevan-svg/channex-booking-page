import { format, parseISO, type Locale } from "date-fns";

import type { BookingCutoff } from "./content";
import type { ClosedDates } from "./channex/types";

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

export function addDaysISO(dateISO: string, n: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** UTC epoch ms for `hour`:`minute` local wall-time on `dateISO` (YYYY-MM-DD) in
 *  `tz`. One-shot offset correction (accurate except across a DST transition at
 *  that exact hour, which doesn't matter for a 17:00 "evening" send, nor for a
 *  cancellation deadline — an hour either way on the one night a year a clock
 *  changes). Falls back to treating the wall-time as UTC when tz is missing or
 *  invalid. */
export function localTimeToUtcMs(dateISO: string, hour: number, tz?: string, minute = 0): number {
  const [y, m, d] = dateISO.split("-").map(Number);
  const guess = Date.UTC(y, (m || 1) - 1, d || 1, hour, minute, 0);
  if (!tz) return guess;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value]),
    );
    let h = parseInt(parts.hour, 10);
    if (h === 24) h = 0;
    // How far the local wall-clock is ahead of UTC at this instant.
    const offset = Date.UTC(+parts.year, +parts.month - 1, +parts.day, h, +parts.minute, +parts.second) - guess;
    return guess - offset;
  } catch {
    return guess; // invalid tz → treat wall-time as UTC
  }
}

/** Parse "HH:MM" to minutes-since-midnight, or null if malformed. */
export function parseHHMM(t?: string): number | null {
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

/** The hotel's cancellation cut-off hour when it hasn't set one. 6pm is the near
 *  universal city-hotel convention, and it matches the booking cutoff's default. */
export const DEFAULT_CANCEL_ANCHOR = "18:00";

export interface CancelDeadline {
  /** The instant the free-cancellation window closes. Gates the cancel button. */
  utcMs: number;
  /** The same moment as the hotel's own wall clock, e.g. "2026-08-09T18:00".
   *  Naive on purpose: it carries no offset, so the server and a guest's browser
   *  in another timezone render the identical string, and what a guest reads is
   *  the time the hotel actually means. */
  local: string;
  /** Whole days before arrival the deadline falls, for undated copy: 0 = the day
   *  of arrival, 1 = the day before. */
  daysBefore: number;
  /** "18:00" — the wall-clock part on its own. */
  time: string;
}

/**
 * When a "free until N hours before arrival" window closes.
 *
 * Anchored to a wall-clock time on the ARRIVAL DATE, not to midnight: a hotel
 * saying "24 hours" means 6pm the night before, not 00:00, and the difference is
 * 18 hours of a guest's flexibility. It also makes `0` a real, useful setting —
 * free cancellation until 6pm on the day you arrive, which is what a flexible
 * city hotel sells — where a midnight anchor could only ever express "the moment
 * the arrival day began".
 *
 * All of it is one subtraction from the anchor, so the arithmetic a hotel expects
 * holds: with an 18:00 anchor, 0h → 18:00 on arrival, 6h → 12:00 on arrival,
 * 24h → 18:00 the day before, 30h → 12:00 the day before.
 */
export function cancelDeadline(
  checkinISO: string,
  hoursBefore: number,
  anchorTime?: string,
  tz?: string,
): CancelDeadline | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkinISO) || !Number.isFinite(hoursBefore) || hoursBefore < 0) {
    return null;
  }
  const anchorMin = parseHHMM(anchorTime) ?? parseHHMM(DEFAULT_CANCEL_ANCHOR)!;
  const totalMin = anchorMin - Math.round(hoursBefore * 60);
  // Floor, so a negative total walks back whole days: -360 is 18:00 yesterday,
  // not "day 0 at minus six hours".
  const dayShift = Math.floor(totalMin / 1440);
  const minOfDay = ((totalMin % 1440) + 1440) % 1440;
  const dateISO = addDaysISO(checkinISO, dayShift);
  const hh = Math.floor(minOfDay / 60);
  const mm = minOfDay % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(hh)}:${pad(mm)}`;
  return {
    utcMs: localTimeToUtcMs(dateISO, hh, tz, mm),
    local: `${dateISO}T${time}`,
    daysBefore: -dayShift,
    time,
  };
}

/** Whether a check-in is too last-minute to accept right now, per the cutoff. */
export function isTooLastMinute(checkin: string, cutoff: BookingCutoff, now: Date = new Date()): boolean {
  if (cutoff.days == null) return false;
  return checkin < earliestCheckinDate(cutoff, now);
}

/**
 * The earliest bookable stay: the first date from `minCheckin` a guest can
 * actually arrive on, paired with its earliest valid check-out. Mirrors the
 * calendar's own arrival test (use-date-range's `arrivalAllowed`): the arrival
 * must be open and not closed-to-arrival, and a run of open nights at least the
 * date's min-stay long must end on a night that isn't closed-to-departure.
 *
 * `null` when the availability data is missing (a pre-selection guessed off no
 * data could sit on a sold night — worse than none) or when nothing is bookable
 * inside the scan horizon.
 */
export function firstAvailableStay(
  closedDates: ClosedDates | null,
  minCheckin: string,
): { checkin: string; checkout: string } | null {
  if (!closedDates) return null;
  const sold = new Set(closedDates.closed);
  const cta = new Set(closedDates.closedToArrival);
  const ctd = new Set(closedDates.closedToDeparture);
  const SCAN_DAYS = 370; // how far out to look for an arrival at all
  for (let a = 0; a < SCAN_DAYS; a++) {
    const arrival = addDaysISO(minCheckin, a);
    if (sold.has(arrival) || cta.has(arrival)) continue;
    const need = Math.max(closedDates.minStayArrival[arrival] ?? 1, 1);
    // Walk the open run from this arrival looking for the first valid check-out.
    for (let nights = 1; nights <= MAX_STAY_NIGHTS; nights++) {
      if (sold.has(addDaysISO(arrival, nights - 1))) break; // run ended before a stay fit
      const out = addDaysISO(arrival, nights);
      if (nights >= need && !ctd.has(out)) return { checkin: arrival, checkout: out };
    }
  }
  return null;
}
