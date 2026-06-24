import { useEffect, useRef, type CSSProperties } from "react";

import { useT } from "~/lib/i18n";
import type { DayCell, DateRangeState } from "~/lib/use-date-range";

function cellStyle(cell: DayCell): CSSProperties {
  if (cell.blank) return { visibility: "hidden" };
  if (cell.disabled) {
    return {
      color: "#c9bdac",
      cursor: "default",
      fontWeight: 400,
      textDecoration: cell.sold ? "line-through" : "none",
    };
  }
  if (cell.isCheckin || cell.isCheckout) {
    return { background: "var(--accent)", color: "#fff", fontWeight: 600 };
  }
  if (cell.inRange) {
    return { background: "var(--accent-soft)", color: "#2a2521", fontWeight: 600 };
  }
  return { color: "#2a2521", fontWeight: 500, cursor: "pointer" };
}

export function CalendarPopover({
  state,
  onClose,
}: {
  state: DateRangeState;
  onClose: () => void;
}) {
  const tr = useT();
  const weekdays = tr.t("weekdays").split(",");
  const ref = useRef<HTMLDivElement>(null);

  // When opened low on the page the popover can fall below the fold; nudge it
  // fully into view (no-op when it's already visible).
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        ref={ref}
        className="absolute left-0 top-[calc(100%+12px)] z-40 w-[min(700px,94vw)] rounded-[18px] border border-line bg-surface p-[22px_22px_18px]"
        style={{ boxShadow: "var(--shadow-popover)" }}
      >
        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={state.prevMonth}
            disabled={!state.canPrev}
            className="h-9 w-9 rounded-[10px] border border-line-alt bg-surface-alt text-[18px] leading-none text-[#5a5145] enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-40"
          >
            ‹
          </button>
          <div className="text-[13px] font-semibold text-muted-2">{tr.t("selectYourDates")}</div>
          <button
            type="button"
            onClick={state.nextMonth}
            disabled={!state.canNext}
            className="h-9 w-9 rounded-[10px] border border-line-alt bg-surface-alt text-[18px] leading-none text-[#5a5145] enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-40"
          >
            ›
          </button>
        </div>

        <div className="flex flex-wrap gap-7">
          {state.months.map((month) => (
            <div key={month.title} className="min-w-[240px] flex-1">
              <div className="mb-3 text-center font-serif text-[17px] font-semibold">
                {month.title}
              </div>
              <div className="mb-1 grid grid-cols-7 gap-0.5">
                {weekdays.map((w) => (
                  <div
                    key={w}
                    className="py-1 text-center text-[11px] font-semibold text-faint"
                  >
                    {w}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-0.5">
                {month.cells.map((cell) => (
                  <div
                    key={cell.key}
                    onClick={cell.disabled ? undefined : () => cell.date && state.handleDay(cell.date)}
                    style={cellStyle(cell)}
                    className="relative flex h-10 items-center justify-center rounded-[10px] text-sm"
                  >
                    {cell.label}
                    {cell.showDot && (
                      <span
                        className="absolute bottom-[5px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {state.helper && (
          <div
            className="mt-3.5 flex items-center gap-2.5 rounded-[10px] px-3.5 py-[11px] text-[13.5px] font-semibold"
            style={{ background: "var(--accent-soft)", color: "var(--accent-deep)" }}
          >
            <span
              className="h-[7px] w-[7px] flex-none rounded-[1px] bg-accent"
              style={{ transform: "rotate(45deg)" }}
            />
            {state.helper}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-divider pt-3.5">
          <div className="flex items-center gap-[18px] text-[12.5px] text-muted-2">
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
          <div className="flex items-center gap-2.5">
            <div className="text-[13px] font-semibold text-secondary">{state.rangeSummary}</div>
            <button
              type="button"
              onClick={state.clear}
              className="cursor-pointer border-none bg-transparent text-[13px] font-semibold text-muted-2 hover:text-accent"
            >
              {tr.t("clear")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-[10px] bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep"
            >
              {tr.t("done")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
