import {
  addDays,
  addMonths,
  differenceInCalendarDays,
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
  /** Past dates render greyed; sold (non-past) dates render struck-through. */
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

export interface UseDateRangeArgs {
  closedDates: ClosedDates | null;
  initialCheckin?: string;
  initialCheckout?: string;
  tr: Translator;
}

export function useDateRange({
  closedDates,
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
  const [monthOffset, setMonthOffset] = useState(0);
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

  const minStayFor = (d: Date) => minStayMap[iso(d)] ?? 1;
  const isSold = (d: Date) => soldSet.has(iso(d));
  const today = startOfToday();

  // A sold-out night can still be a valid CHECK-OUT (you don't sleep there):
  // true when picking a check-out, `date` is after check-in, meets min-stay,
  // isn't closed-to-departure, and every night in between is available.
  const checkoutAllowed = (date: Date) => {
    if (!checkin || checkout || !isBefore(checkin, date)) return false;
    if (ctdSet.has(iso(date))) return false;
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
        const past = isBefore(date, today);
        const sold = isSold(date);
        // Sold nights stay un-pickable for arrival, but open up as a check-out.
        const asCheckout = checkoutAllowed(date);
        // First sold night after an available run — you can still check out here.
        const prev = addDays(date, -1);
        const checkoutBoundary = sold && !isSold(prev) && !isBefore(prev, today);
        const disabled = past ? true : asCheckout ? false : sold;
        let title: string | undefined;
        if (!past) {
          if (sold) title = asCheckout || checkoutBoundary ? tr.t("checkoutOnly") : tr.t("unavailable");
          else if (ctaSet.has(iso(date))) title = tr.t("checkoutOnly");
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
          past,
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
  }, [checkin, checkout, monthOffset, soldSet, minStayMap, ctaSet, ctdSet]);

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
