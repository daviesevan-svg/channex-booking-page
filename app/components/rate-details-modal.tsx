import { useEffect } from "react";
import { createPortal } from "react-dom";

import type { RatePlan } from "~/lib/channex/types";
import { useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";

/** Popup showing a rate plan's full content: photos, description, what's
 *  included and cancellation policy. Driven entirely by loader data — no fetch. */
export function RateDetailsModal({
  rate,
  currency,
  nights,
  onClose,
}: {
  rate: RatePlan;
  currency: string;
  nights: number;
  onClose: () => void;
}) {
  const tr = useT();
  const perNight = Number(rate.totalPrice) / Math.max(1, nights);
  const cancellation = rate.cancellationNote || rate.cancellationPolicy?.title;
  const images = rate.images ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={rate.title}
        className="relative z-10 max-h-[85vh] w-full max-w-[480px] overflow-y-auto rounded-[18px] border border-line bg-surface p-6 text-left"
        style={{ boxShadow: "var(--shadow-confirm)" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={tr.t("close")}
          className="absolute right-4 top-4 text-[22px] leading-none text-muted-2 hover:text-accent"
        >
          ×
        </button>

        <h3 className="pr-8 font-serif text-[24px] font-semibold tracking-[-0.01em]">{rate.title}</h3>
        <div className="mt-1 text-[14px] text-muted-2">
          {formatMoney(perNight, currency)} {tr.t("perNight")} · {tr.t("totalNights", { n: nights })}{" "}
          {formatMoney(rate.totalPrice, currency)}
        </div>

        {images.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-2">
            {images.slice(0, 4).map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                className={`h-28 w-full rounded-[10px] object-cover ${
                  images.length === 1 ? "col-span-2 h-40" : ""
                }`}
              />
            ))}
          </div>
        )}

        {rate.description && (
          <p className="mt-4 text-[14.5px] leading-[1.6] text-secondary">{rate.description}</p>
        )}

        {rate.mealPlan && (
          <div className="mt-4 text-[14px] font-semibold text-secondary">{rate.mealPlan}</div>
        )}

        {rate.inclusions?.length ? (
          <div className="mt-4">
            <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-2">
              {tr.t("whatsIncluded")}
            </div>
            <ul className="flex flex-col gap-1.5">
              {rate.inclusions.map((inc, i) => (
                <li key={i} className="flex items-start gap-2 text-[14px] text-[#4a4236]">
                  <span
                    className="mt-[6px] h-[6px] w-[6px] flex-none rounded-[1px] bg-accent"
                    style={{ transform: "rotate(45deg)" }}
                  />
                  {inc}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {cancellation && (
          <div className="mt-4 border-t border-divider pt-4">
            <div className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-muted-2">
              {tr.t("cancellation")}
            </div>
            <div className="text-[14px] text-secondary">{cancellation}</div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
