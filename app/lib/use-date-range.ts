import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  format,
  getDay,
  getDaysInMonth,
  isBefore,
  parseISO,
  startOfMonth,
  startOfToday,
} from "date-fns";
import { useMemo, useState } from "react";

import type { ClosedDates } from "./channex/types";
import type { Translator } from "./i18n";

export interface DayCell {
  key: string;
  blank: boolean;
  label: string;
  iso?: string;
  date?: Date;
  disabled: boolean;
  sold: boolean;
  /**
   * Out of range: before the arrival floor, or past a ceiling the caller set.
   * Renders greyed, where a sold (in-range) date renders struck-through — "this
   * stay can't use that date" is not "nobody can have that night".
   */
  past: boolean;
  /** A sold night whose previous night is available — i.e. reachable as a
   *  check-out. Styled black+struck; deeper sold nights stay plain grey. */
  checkoutBoundary: boolean;
  /** Native-tooltip hint, e.g. "Unavailable" or "Check-out only". */
  title?: string;
  isCheckin: boolean;
  isCheckout: boolean;
  inRange: boolean;
  showDot: boolean;
}

export interface CalMonth {
  title: string;
  cells: DayCell[];
}

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const MAX_OFFSET = 11;

/** How many months forward the calendar should open on for a target date, within
 *  the range it can page to. 0 for no date, a past one, or today's month. */
function monthsAhead(target: string | undefined): number {
  if (!target) return 0;
  const d = parseISO(target);
  if (Number.isNaN(d.getTime())) return 0;
  const months = differenceInCalendarMonths(startOfMonth(d), startOfMonth(startOfToday()));
  return Math.min(MAX_OFFSET, Math.max(0, months));
}

export interface UseDateRangeArgs {
  closedDates: ClosedDates | null;
  /** Earliest selectable check-in (YYYY-MM-DD); dates before it are greyed out.
   *  Used for the booking lead-time cutoff. Defaults to today. */
  minCheckin?: string;
  /**
   * Latest selectable check-in, and latest selectable check-out.
   *
   * For a stay that has to fall inside a window — an offer's stay dates — where
   * the two ceilings are genuinely different: a 3-night stay starting on the last
   * eligible arrival departs three days after it, so capping both at the same date
   * would make the last few arrivals unusable. Absent means no ceiling, which is
   * every caller that isn't the offer page.
   */
  maxCheckin?: string;
  maxCheckout?: string;
  /** A minimum stay the CALLER imposes, on top of whatever the inventory's
   *  per-date min-stay says. The longer of the two applies. */
  minNights?: number;
  initialCheckin?: string;
  initialCheckout?: string;
  tr: Translator;
}

export function useDateRange({
  closedDates,
  minCheckin,
  maxCheckin,
  maxCheckout,
  minNights: minNightsFloor,
  initialCheckin,
  initialCheckout,
  tr,
}: UseDateRangeArgs) {
  const fmt = (d: Date, f: string) => format(d, f, { locale: tr.locale });
  const [checkin, setCheckin] = useState<Date | null>(
    initialCheckin ? parseISO(initialCheckin) : null,
  );
  const [checkout, setCheckout] = useState<Date | null>(
    initialCheckout ? parseISO(initialCheckout) : null,
  );
  // Open on the first month that has something to pick, rather than always on
  // this one: an offer whose earliest stay is two months out otherwise greets the
  // guest with a calendar of greyed dates and no hint to page forward. For every
  // other caller `minCheckin` is a lead-time of hours or days, so this is the
  // current month exactly as before.
  const [monthOffset, setMonthOffset] = useState(() =>
    monthsAhead(initialCheckin || minCheckin),
  );
  const [helper, setHelper] = useState("");

  const soldSet = useMemo(
    () => new Set(closedDates?.closed ?? []),
    [closedDates],
  );
  const minStayMap = useMemo(
    () => closedDates?.minStayArrival ?? {},
    [closedDates],
  );
  const ctaSet = useMemo(() => new Set(closedDates?.closedToArrival ?? []), [closedDates]);
  const ctdSet = useMemo(() => new Set(closedDates?.closedToDeparture ?? []), [closedDates]);

  // The caller's floor and the inventory's per-date rule are both minimums, so
  // the longer one wins — an offer needing 3 nights can't be satisfied by the
  // hotel's 2-night minimum, and vice versa.
  const minStayFor = (d: Date) => Math.max(minStayMap[iso(d)] ?? 1, minNightsFloor ?? 1);
  const isSold = (d: Date) => soldSet.has(iso(d));
  const today = startOfToday();
  // Arrival and departure ceilings. Compared as dates rather than strings because
  // everything else in this hook is a Date.
  const lastArrival = maxCheckin ? parseISO(maxCheckin) : null;
  const lastDeparture = maxCheckout ? parseISO(maxCheckout) : null;
  const afterLastArrival = (d: Date) => !!lastArrival && isBefore(lastArrival, d);
  const afterLastDeparture = (d: Date) => !!lastDeparture && isBefore(lastDeparture, d);
  // Arrival floor = the later of today and the lead-time cutoff. Dates before it
  // can't be selected as a check-in (greyed like past dates).
  const minArrival = minCheckin ? parseISO(minCheckin) : today;
  const floor = isBefore(minArrival, today) ? today : minArrival;

  // Longest stay we'll look ahead for when testing whether an arrival is even
  // possible. Dates with no loaded availability read as open, so the walk stops
  // on the first sold night in practice; this only bounds the pathological case.
  const MAX_LOOKAHEAD_NIGHTS = 370;

  // Can a guest actually ARRIVE on this date? Not the same question as "is this
  // night for sale". A date whose run of available nights is shorter than its own
  // minimum stay is a dead end: the guest picks it, gets told to choose a
  // check-out N nights later, and every date that would satisfy that is sold.
  //
  // So walk forward from `date` while nights are available and look for a stay
  // length that both meets the minimum AND lands on a day you're allowed to
  // depart. If none exists, the date can't start a booking.
  const arrivalAllowed = (date: Date) => {
    if (isSold(date) || ctaSet.has(iso(date))) return false;
    if (afterLastArrival(date)) return false;
    const need = minStayFor(date);
    let nights = 0;
    while (!isSold(addDays(date, nights))) {
      nights++;
      const out = addDays(date, nights);
      // A stay that would have to depart past the ceiling is no use here either:
      // the last eligible arrivals of a window are exactly where this bites.
      if (afterLastDeparture(out)) return false;
      if (nights >= need && !ctdSet.has(iso(out))) return true;
      if (nights >= MAX_LOOKAHEAD_NIGHTS) break;
    }
    return false;
  };

  // A sold-out night can still be a valid CHECK-OUT (you don't sleep there):
  // true when picking a check-out, `date` is after check-in, meets min-stay,
  // isn't closed-to-departure, and every night in between is available.
  const checkoutAllowed = (date: Date) => {
    if (!checkin || checkout || !isBefore(checkin, date)) return false;
    if (ctdSet.has(iso(date)) || afterLastDeparture(date)) return false;
    if (differenceInCalendarDays(date, checkin) < minStayFor(checkin)) return false;
    for (let d = checkin; isBefore(d, date); d = addDays(d, 1)) if (isSold(d)) return false;
    return true;
  };

  function handleDay(date: Date) {
    if (!checkin || checkout || !isBefore(checkin, date)) {
      if (ctaSet.has(iso(date))) {
        setHelper(tr.t("helperClosedToArrival", { date: fmt(date, "EEE d MMM") }));
        return;
      }
      // Explain the ceiling rather than just refusing: a greyed date with no
      // reason reads as broken, and this one isn't about availability.
      if (afterLastArrival(date)) {
        setHelper(tr.t("helperMaxArrival", { date: fmt(lastArrival!, "EEE d MMM") }));
        return;
      }
      const minS = minStayFor(date);
      setCheckin(date);
      setCheckout(null);
      setHelper(
        minS > 1
          ? tr.t("helperMinStayArrival", { n: minS, date: fmt(date, "EEE d MMM") })
          : "",
      );
      return;
    }
    if (ctdSet.has(iso(date))) {
      setHelper(tr.t("helperClosedToDeparture", { date: fmt(date, "EEE d MMM") }));
      return;
    }
    if (afterLastDeparture(date)) {
      setHelper(tr.t("helperMaxDeparture", { date: fmt(lastDeparture!, "EEE d MMM") }));
      return;
    }
    const nights = differenceInCalendarDays(date, checkin);
    const minS = minStayFor(checkin);
    if (nights < minS) {
      setHelper(
        tr.t("helperMinStayCheckout", { n: minS, date: fmt(addDays(checkin, minS), "EEE d MMM") }),
      );
      return;
    }
    for (let d = checkin; isBefore(d, date); d = addDays(d, 1)) {
      if (isSold(d)) {
        setHelper(tr.t("helperSoldOut"));
        return;
      }
    }
    setCheckout(date);
    setHelper("");
  }

  function clear() {
    setCheckin(null);
    setCheckout(null);
    setHelper("");
  }

  const months = useMemo<CalMonth[]>(() => {
    const baseMonth = startOfMonth(today);
    return [0, 1].map((i) => {
      const monthDate = addMonths(baseMonth, monthOffset + i);
      const title = fmt(monthDate, "MMMM yyyy");
      const firstDow = (getDay(monthDate) + 6) % 7; // Monday-first
      const dim = getDaysInMonth(monthDate);
      const cells: DayCell[] = [];
      for (let b = 0; b < firstDow; b++) {
        cells.push({
          key: `b-${i}-${b}`,
          blank: true,
          label: "",
          disabled: true,
          sold: false,
          past: false,
          checkoutBoundary: false,
          isCheckin: false,
          isCheckout: false,
          inRange: false,
          showDot: false,
        });
      }
      for (let d = 1; d <= dim; d++) {
        const date = new Date(monthDate.getFullYear(), monthDate.getMonth(), d);
        // Past dates and those inside the lead-time gap are both un-bookable as
        // arrivals; render them greyed.
        const tooEarly = isBefore(date, floor);
        const sold = isSold(date);
        // Sold nights stay un-pickable for arrival, but open up as a check-out.
        const asCheckout = checkoutAllowed(date);
        // First sold night after an available run — you can still check out here.
        const prev = addDays(date, -1);
        const checkoutBoundary = sold && !isSold(prev) && !isBefore(prev, today);
        // Whether clicking this date would set a CHECK-IN — the same test
        // handleDay uses. The arrival constraint must only apply then: while a
        // check-out is being chosen, an available date has to stay clickable so
        // handleDay can explain why it doesn't work.
        const asArrival = !checkin || !!checkout || !isBefore(checkin, date);
        const arrivalBlocked = asArrival && !sold && !arrivalAllowed(date);
        // Past the departure ceiling nothing can be picked at all. Past the
        // ARRIVAL ceiling a date can still be a check-out, so it's only blocked
        // when it would be an arrival — which `arrivalAllowed` already refuses.
        const tooLate = afterLastDeparture(date);
        // Greyed as out-of-range, not struck through as sold: it's a date this
        // stay can't use, which is a different thing from a night nobody can have.
        const outOfRange = tooEarly || tooLate || (asArrival && afterLastArrival(date) && !sold);
        const disabled = tooEarly || tooLate ? true : asCheckout ? false : sold || arrivalBlocked;
        let title: string | undefined;
        if (!tooEarly && !tooLate) {
          if (sold) title = asCheckout || checkoutBoundary ? tr.t("checkoutOnly") : tr.t("unavailable");
          else if (ctaSet.has(iso(date))) title = tr.t("checkoutOnly");
          else if (afterLastArrival(date)) title = tr.t("helperMaxArrival", { date: fmt(lastArrival!, "EEE d MMM") });
          else if (arrivalBlocked) title = tr.t("minStayUnreachable", { n: minStayFor(date) });
        }
        const isCheckin = !!checkin && differenceInCalendarDays(date, checkin) === 0;
        const isCheckout = !!checkout && differenceInCalendarDays(date, checkout) === 0;
        const inRange =
          !!checkin &&
          !!checkout &&
          isBefore(checkin, date) &&
          isBefore(date, checkout);
        const showDot = !disabled && minStayFor(date) > 1 && !isCheckin && !isCheckout;
        cells.push({
          key: iso(date),
          blank: false,
          label: String(d),
          iso: iso(date),
          date,
          disabled,
          sold,
          past: outOfRange,
          checkoutBoundary,
          title,
          isCheckin,
          isCheckout,
          inRange,
          showDot,
        });
      }
      return { title, cells };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    checkin,
    checkout,
    monthOffset,
    soldSet,
    minStayMap,
    ctaSet,
    ctdSet,
    minCheckin,
    maxCheckin,
    maxCheckout,
    minNightsFloor,
  ]);

  let rangeSummary: string;
  if (checkin && checkout) {
    rangeSummary = tr.p("nightsSelected", differenceInCalendarDays(checkout, checkin));
  } else if (checkin) {
    rangeSummary = tr.t("selectCheckout");
  } else {
    rangeSummary = tr.t("selectYourDates");
  }

  return {
    checkin,
    checkout,
    checkinIso: checkin ? iso(checkin) : "",
    checkoutIso: checkout ? iso(checkout) : "",
    checkinLabel: checkin ? fmt(checkin, "EEE d MMM") : tr.t("selectDate"),
    checkoutLabel: checkout ? fmt(checkout, "EEE d MMM") : tr.t("selectDate"),
    helper,
    rangeSummary,
    months,
    monthOffset,
    canPrev: monthOffset > 0,
    canNext: monthOffset < MAX_OFFSET,
    prevMonth: () => setMonthOffset((o) => Math.max(0, o - 1)),
    nextMonth: () => setMonthOffset((o) => Math.min(MAX_OFFSET, o + 1)),
    handleDay,
    clear,
  };
}

export type DateRangeState = ReturnType<typeof useDateRange>;
