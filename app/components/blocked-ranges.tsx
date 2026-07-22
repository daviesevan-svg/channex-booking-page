// Picker-based editor for blocked date ranges (voucher packages). Ranges are
// added with native date inputs and shown as removable chips, so bad formats
// can't be typed; the list posts through a hidden input in the same
// "YYYY-MM-DD..YYYY-MM-DD"-per-line format the actions already parse (which
// stays as the server-side backstop).
import { useState } from "react";

import { useAdminDateLocale, useAdminT } from "~/lib/admin-i18n";
import { fmtDate } from "~/lib/dates";
import { blockedRangesToText } from "~/lib/vouchers";

type R = { from: string; to: string };

export function BlockedRangesEditor({ name, initial }: { name: string; initial: R[] }) {
  const t = useAdminT();
  const dl = useAdminDateLocale();
  const [ranges, setRanges] = useState<R[]>(initial);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const input =
    "rounded-[10px] border border-line-alt bg-surface px-2.5 py-2 text-[13.5px] text-ink outline-none focus:border-accent";

  const add = () => {
    if (!from) {
      setError(t("brPickStart"));
      return;
    }
    const end = to || from; // single-day block
    if (end < from) {
      setError(t("brEndBeforeStart"));
      return;
    }
    if (ranges.some((r) => from <= r.to && end >= r.from)) {
      setError(t("brOverlap"));
      return;
    }
    setRanges([...ranges, { from, to: end }].sort((a, b) => a.from.localeCompare(b.from)));
    setFrom("");
    setTo("");
    setError(null);
  };

  const label = (r: R) =>
    r.from === r.to
      ? fmtDate(r.from, "d MMM yyyy", dl)
      : `${fmtDate(r.from, "d MMM yyyy", dl)} – ${fmtDate(r.to, "d MMM yyyy", dl)}`;

  return (
    <div className="mt-1.5">
      <input type="hidden" name={name} value={blockedRangesToText(ranges)} />

      {ranges.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-2">
          {ranges.map((r, i) => (
            <span
              key={`${r.from}..${r.to}`}
              className="inline-flex items-center gap-2 rounded-full border border-chip-border bg-chip px-3 py-1.5 text-[12.5px] font-semibold text-secondary"
            >
              {label(r)}
              <button
                type="button"
                aria-label={t("brRemove", { range: label(r) })}
                onClick={() => setRanges(ranges.filter((_, j) => j !== i))}
                className="text-[15px] leading-none text-muted-2 hover:text-[#c0392b]"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setError(null);
          }}
          className={input}
          aria-label={t("brFrom")}
        />
        <span className="text-[13px] text-muted-2">{t("brTo")}</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => {
            setTo(e.target.value);
            setError(null);
          }}
          className={input}
          aria-label={t("brUntil")}
        />
        <button
          type="button"
          onClick={add}
          className="rounded-[10px] border border-line-alt px-3.5 py-2 text-[13px] font-semibold text-secondary hover:bg-chip"
        >
          {t("brBlockDates")}
        </button>
      </div>
      {error && <p className="mb-0 mt-1.5 text-[12.5px] text-red-600">{error}</p>}
      <p className="mb-0 mt-1.5 text-[11.5px] font-normal text-faint">{t("brHint")}</p>
    </div>
  );
}
