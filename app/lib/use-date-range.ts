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
        const disabled = past || sold;
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
          isCheckin,
          isCheckout,
          inRange,
          showDot,
        });
      }
      return { title, cells };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkin, checkout, monthOffset, soldSet, minStayMap]);

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
