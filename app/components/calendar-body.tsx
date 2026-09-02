// The month grid shared by the search popover and the always-on room calendar.
//
// Extracted rather than reimplemented: the day cells carry a lot of subtlety
// (sold nights you can still check out on, closed-to-arrival, min-stay dots,
// the past). A second hand-rolled grid would drift from the booking gate, and
// a calendar that disagrees with what you can actually book is worse than no
// calendar.

import type { CSSProperties } from "react";

import { useT } from "~/lib/i18n";
import type { DayCell, DateRangeState } from "~/lib/use-date-range";

export function cellStyle(cell: DayCell): CSSProperties {
  if (cell.blank) return { visibility: "hidden" };
  // A selected day always looks selected — even a sold-out night chosen as the
  // check-out (which is otherwise un-clickable).
  if (cell.isCheckin || cell.isCheckout) {
    return { background: "var(--accent)", color: "var(--on-accent)", fontWeight: 600 };
  }
  if (cell.inRange) {
    return { background: "var(--accent-soft)", color: "var(--color-ink)", fontWeight: 600 };
  }
  if (cell.past) {
    return { color: "#c9bdac", cursor: "default", fontWeight: 400 };
  }
  if (cell.disabled) {
    // The first sold night after an available run reads as readable black with a
    // strike-through (you can still check out on it). Deeper sold/closed nights
    // use the plain greyed-out unavailable style.
    return {
      color: cell.checkoutBoundary ? "var(--color-ink)" : "#c9bdac",
      cursor: "default",
      fontWeight: 400,
      textDecoration: cell.sold ? "line-through" : "none",
    };
  }
  return { color: "var(--color-ink)", fontWeight: 500, cursor: "pointer" };
}

/** Prev / title / next. `title` defaults to "Select your dates". */
export function CalendarNav({ state, title }: { state: DateRangeState; title?: string }) {
  const tr = useT();
  return (
    <div className="mb-3 flex items-center justify-between">
      <button
        type="button"
        onClick={state.prevMonth}
        disabled={!state.canPrev}
        aria-label={tr.t("prevMonth")}
        className="h-9 w-9 rounded-control border border-line-alt bg-surface-alt text-title-sm leading-none text-secondary enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-40"
      >
        ‹
      </button>
      <div className="text-caption font-semibold text-muted-2">{title ?? tr.t("selectYourDates")}</div>
      <button
        type="button"
        onClick={state.nextMonth}
        disabled={!state.canNext}
        aria-label={tr.t("nextMonth")}
        className="h-9 w-9 rounded-control border border-line-alt bg-surface-alt text-title-sm leading-none text-secondary enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-40"
      >
        ›
      </button>
    </div>
  );
}

/** The months themselves plus the min-stay / closed-to-arrival helper line. */
export function CalendarMonths({ state }: { state: DateRangeState }) {
  const tr = useT();
  const weekdays = tr.t("weekdays").split(",");
  return (
    <div>
      <div className="flex flex-wrap gap-7">
        {state.months.map((month) => (
          <div key={month.title} className="min-w-[240px] flex-1">
            <div className="mb-3 text-center font-serif text-lead font-semibold">
              {month.title}
            </div>
            <div className="mb-1 grid grid-cols-7 gap-0.5">
              {weekdays.map((w) => (
                <div key={w} className="py-1 text-center text-micro font-semibold text-faint">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {month.cells.map((cell) => (
                <div
                  key={cell.key}
                  title={cell.title}
                  onClick={cell.disabled ? undefined : () => cell.date && state.handleDay(cell.date)}
                  style={cellStyle(cell)}
                  className="relative flex h-10 items-center justify-center rounded-control text-sm"
                >
                  {cell.label}
                  {cell.showDot && (
                    <span className="absolute bottom-[5px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent" />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {state.helper && (
        <div
          className="mt-3.5 flex items-center gap-2.5 rounded-control px-3.5 py-[11px] text-caption font-semibold"
          style={{ background: "var(--accent-soft)", color: "var(--accent-deep)" }}
        >
          <span
            className="h-[7px] w-[7px] flex-none rounded-mark bg-accent"
            style={{ transform: "rotate(45deg)" }}
          />
          {state.helper}
        </div>
      )}
    </div>
  );
}

/** "12 unavailable · • min stay applies". */
export function CalendarLegend() {
  const tr = useT();
  return (
    <div className="flex items-center gap-[18px] text-label text-muted-2">
      <span className="flex items-center gap-1.5">
        <span className="text-disabled-day line-through">12</span> {tr.t("unavailable")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="relative inline-block h-3.5 w-3.5">
          <span className="absolute bottom-0 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent" />
        </span>
        {tr.t("minStayApplies")}
      </span>
    </div>
  );
}
