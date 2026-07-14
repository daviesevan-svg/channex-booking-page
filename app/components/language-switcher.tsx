import { useEffect, useRef, useState } from "react";

import { langFlag, langLabel } from "~/lib/content";

/** Guest-facing language picker for the booking header: a flag + endonym button
 *  that opens a small popover of the enabled languages (flag + the language's
 *  own name). Closes on outside-click, Escape, or a choice. Only render it when
 *  there's more than one language to choose from. */
export function LanguageSwitcher({
  languages,
  current,
  onSelect,
}: {
  languages: string[];
  current: string;
  onSelect: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (code: string) => {
    setOpen(false);
    if (code !== current) onSelect(code);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Change language"
        className="flex items-center gap-2 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px] font-semibold text-secondary outline-none hover:border-accent focus-visible:border-accent"
      >
        <span className="text-[15px] leading-none">{langFlag(current)}</span>
        <span>{langLabel(current)}</span>
        <span
          className={`text-[9px] leading-none text-muted-2 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          ▼
        </span>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute right-0 z-30 mt-1.5 min-w-[168px] overflow-hidden rounded-[10px] border border-line bg-surface py-1 shadow-[0_16px_36px_-20px_rgba(70,55,35,0.5)]"
        >
          {languages.map((code) => {
            const active = code === current;
            return (
              <li key={code} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => choose(code)}
                  className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13.5px] hover:bg-field-hover ${
                    active ? "font-semibold text-accent" : "text-secondary"
                  }`}
                >
                  <span className="text-[16px] leading-none">{langFlag(code)}</span>
                  <span className="flex-1">{langLabel(code)}</span>
                  {active && (
                    <span className="text-[12px] leading-none text-accent" aria-hidden>
                      ✓
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
