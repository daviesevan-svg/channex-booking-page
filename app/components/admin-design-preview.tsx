// The property's own home page, rendered live beside the design controls.
//
// A hotel used to pick a template, save, then go and look. This shows the choice
// before it is written, which is the thing that makes the choice safe to offer —
// and the reason it can exist at all is that the guest layout accepts `?style=`
// and `?font=` from a signed-in admin.
//
// An iframe rather than a rendering of our own: a second implementation of the
// page would be a second thing to keep in step, and it would be wrong exactly
// when it mattered.

import { useAdminT } from "~/lib/admin-i18n";

export function DesignPreview({
  path,
  style,
  font,
  saved,
}: {
  /** The property's public path — the slug guests actually see. */
  path: string;
  style: string;
  font: string;
  /** What is actually stored, so the panel can say when the two differ. */
  saved: { style: string; font: string };
}) {
  const t = useAdminT();
  const unsaved = style !== saved.style || font !== saved.font;
  const src = `${path}?style=${encodeURIComponent(style)}&font=${encodeURIComponent(font)}`;

  return (
    <div className="mb-6 rounded-[14px] border border-line bg-surface p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <div className="font-serif text-[18px] font-semibold">{t("previewTitle")}</div>
        <div className="flex items-center gap-3">
          {unsaved && (
            <span className="rounded-full bg-[#fbf6ea] px-3 py-1 text-[12px] font-semibold text-[#7a6636]">
              {t("previewUnsaved")}
            </span>
          )}
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-semibold text-accent hover:underline"
          >
            {t("previewOpen")} ↗
          </a>
        </div>
      </div>
      <p className="mb-4 text-[13px] leading-[1.55] text-muted">{t("previewIntro")}</p>

      {/* `key` on the src forces a reload when the choice changes: the guest page
          reads the style on the SERVER, so re-rendering with a new src is the
          whole update mechanism. */}
      <div className="overflow-hidden rounded-[10px] border border-line-alt bg-surface-alt">
        <iframe
          key={src}
          src={src}
          title={t("previewTitle")}
          loading="lazy"
          className="block h-[560px] w-full"
        />
      </div>
    </div>
  );
}
