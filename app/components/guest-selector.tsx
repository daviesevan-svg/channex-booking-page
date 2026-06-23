import { useState } from "react";

import type { Occupancy } from "~/lib/occupancy";
import { occupancyLabel } from "~/lib/occupancy";

const MAX_ADULTS = 12;
const MAX_CHILDREN = 8;
const DEFAULT_CHILD_AGE = 8;
const CHILD_MAX_AGE = 17;

function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const btn =
    "flex h-9 w-9 items-center justify-center rounded-full border border-line-alt bg-surface-alt text-[18px] leading-none text-[#5a5145] transition-colors enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-30";
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className={btn}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        aria-label="Decrease"
      >
        −
      </button>
      <span className="w-6 text-center text-[16px] font-semibold tabular-nums">{value}</span>
      <button
        type="button"
        className={btn}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        aria-label="Increase"
      >
        +
      </button>
    </div>
  );
}

export function GuestSelector({
  value,
  onChange,
}: {
  value: Occupancy;
  onChange: (next: Occupancy) => void;
}) {
  const [open, setOpen] = useState(false);
  const { adults, childrenAge } = value;

  function setAdults(n: number) {
    onChange({ ...value, adults: n });
  }
  function setChildrenCount(n: number) {
    const next = [...childrenAge];
    while (next.length < n) next.push(DEFAULT_CHILD_AGE);
    next.length = n;
    onChange({ ...value, childrenAge: next });
  }
  function setChildAge(i: number, age: number) {
    const next = [...childrenAge];
    next[i] = age;
    onChange({ ...value, childrenAge: next });
  }

  return (
    <div className="relative min-w-[160px] flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full cursor-pointer rounded-[12px] px-[18px] py-3.5 text-left transition-colors hover:bg-field-hover"
      >
        <div className="field-label mb-1.5">Guests</div>
        <div className="text-[17px] font-semibold">{occupancyLabel(adults, childrenAge)}</div>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 top-[calc(100%+12px)] z-40 w-[min(360px,92vw)] rounded-[18px] border border-line bg-surface p-5"
            style={{ boxShadow: "var(--shadow-popover)" }}
          >
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-[15px] font-semibold">Adults</div>
                <div className="text-[13px] text-muted-2">Age 18+</div>
              </div>
              <Stepper value={adults} min={1} max={MAX_ADULTS} onChange={setAdults} />
            </div>

            <div className="flex items-center justify-between border-t border-divider py-2 pt-3">
              <div>
                <div className="text-[15px] font-semibold">Children</div>
                <div className="text-[13px] text-muted-2">Age 0–17</div>
              </div>
              <Stepper
                value={childrenAge.length}
                min={0}
                max={MAX_CHILDREN}
                onChange={setChildrenCount}
              />
            </div>

            {childrenAge.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-3 border-t border-divider pt-4">
                {childrenAge.map((age, i) => (
                  <label key={i} className="text-[13px] font-semibold text-secondary">
                    Child {i + 1} age
                    <select
                      value={age}
                      onChange={(e) => setChildAge(i, Number(e.target.value))}
                      className="mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3 py-2 text-[15px] text-ink outline-none focus:border-accent"
                    >
                      {Array.from({ length: CHILD_MAX_AGE + 1 }, (_, a) => (
                        <option key={a} value={a}>
                          {a === 0 ? "Under 1" : a}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-4 w-full rounded-[10px] bg-accent py-2.5 text-sm font-semibold text-white hover:bg-accent-deep"
            >
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}
