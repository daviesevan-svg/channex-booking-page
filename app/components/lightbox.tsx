import { useEffect } from "react";

import type { Translator } from "~/lib/i18n";

/** Full-screen photo viewer: one large image with prev/next, a counter, and
 *  close (× button, backdrop click, or Escape). Arrow keys page through. */
export function Lightbox({
  photos,
  index,
  title,
  tr,
  onChange,
  onClose,
}: {
  photos: { url: string }[];
  index: number | null;
  title: string;
  tr: Translator;
  onChange: (i: number) => void;
  onClose: () => void;
}) {
  const total = photos.length;
  useEffect(() => {
    if (index == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onChange((index + 1) % total);
      else if (e.key === "ArrowLeft") onChange((index - 1 + total) % total);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, total, onChange, onClose]);
  if (index == null || total === 0) return null;

  const arrow =
    "absolute top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-3xl leading-none text-white hover:bg-white/25";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tr.t("viewAllPhotos")}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/12 text-2xl leading-none text-white hover:bg-white/25"
      >
        ×
      </button>
      {total > 1 && (
        <button
          type="button"
          aria-label="Previous"
          onClick={(e) => {
            e.stopPropagation();
            onChange((index - 1 + total) % total);
          }}
          className={`${arrow} left-4`}
        >
          ‹
        </button>
      )}
      <figure onClick={(e) => e.stopPropagation()} className="flex max-h-full flex-col items-center">
        <img
          src={photos[index].url}
          alt={title}
          className="max-h-[82vh] w-auto max-w-full rounded-[12px] object-contain"
        />
        {total > 1 && (
          <figcaption className="mt-3 text-[13px] text-white/70">
            {index + 1} / {total}
          </figcaption>
        )}
      </figure>
      {total > 1 && (
        <button
          type="button"
          aria-label="Next"
          onClick={(e) => {
            e.stopPropagation();
            onChange((index + 1) % total);
          }}
          className={`${arrow} right-4`}
        >
          ›
        </button>
      )}
    </div>
  );
}
