import { useEffect, useRef, useState } from "react";

import { CalendarLegend, CalendarMonths, CalendarNav } from "~/components/calendar-body";
import { useT } from "~/lib/i18n";
import type { DateRangeState } from "~/lib/use-date-range";

export function CalendarPopover({
  state,
  onClose,
}: {
  state: DateRangeState;
  onClose: () => void;
}) {
  const tr = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);

  // Render at full size, but cap the popover to the space available below its
  // trigger (it may sit low, e.g. inside a sticky bar the page can't scroll) and
  // let the WHOLE popover scroll. So on a tall screen everything shows at once,
  // and on a short one you scroll inside the popover to reach every date, the
  // "Min stay …" note, the legend and the Clear/Done buttons — nothing is ever
  // cropped off. Recompute on resize.
  useEffect(() => {
    const compute = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setMaxH(Math.max(320, Math.round(window.innerHeight - top - 16)));
    };
    let inner = 0;
    // Scroll into view (instant, so layout settles this frame), then measure the
    // available space on the NEXT frame — measuring before the scroll finishes
    // would under-cap the height and scroll needlessly on roomy pages.
    const outer = requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ block: "nearest" });
      inner = requestAnimationFrame(compute);
    });
    window.addEventListener("resize", compute);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.removeEventListener("resize", compute);
    };
  }, []);

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        ref={ref}
        className="absolute left-0 top-[calc(100%+12px)] z-40 w-[min(700px,94vw)] overflow-y-auto rounded-panel-lg border border-line bg-surface p-[22px_22px_18px]"
        style={{ boxShadow: "var(--shadow-popover)", maxHeight: maxH ? `${maxH}px` : undefined }}
      >
        <CalendarNav state={state} />
        <CalendarMonths state={state} />

        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-divider pt-3.5">
          <CalendarLegend />
          <div className="flex items-center gap-2.5">
            <div className="text-caption font-semibold text-secondary">{state.rangeSummary}</div>
            <button
              type="button"
              onClick={state.clear}
              className="cursor-pointer border-none bg-transparent text-caption font-semibold text-muted-2 hover:text-accent"
            >
              {tr.t("clear")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-control bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep"
            >
              {tr.t("done")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
