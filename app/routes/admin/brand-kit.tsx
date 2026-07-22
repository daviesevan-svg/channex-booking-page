import { useState } from "react";

import type { Route } from "./+types/brand-kit";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { buildBrandKit } from "~/lib/brand-kit.server";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const kit = await buildBrandKit(propertyId);
  return { configured: true as const, ...kit };
}

export function meta() {
  return [{ title: "Admin · Brand kit" }];
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useAdminT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard blocked — the text is visible to copy manually */
        }
      }}
      className="flex-none rounded-[8px] border border-line-alt bg-surface px-3 py-1.5 text-[12px] font-semibold text-secondary hover:border-accent hover:text-accent"
    >
      {copied ? t("bktCopied") : (label ?? t("bktCopy"))}
    </button>
  );
}

function Swatch({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-8 w-8 flex-none rounded-[8px] border border-line-alt" style={{ background: value }} />
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold text-secondary">{label}</span>
        <span className="block truncate font-mono text-[11px] text-muted">{value}</span>
      </span>
    </div>
  );
}

export default function BrandKit({ loaderData }: Route.ComponentProps) {
  const t = useAdminT();
  const [copied, setCopied] = useState(false);

  if (!loaderData.configured) {
    return (
      <div>
        <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("bktTitle")}</h1>
        <p className="text-[14px] text-muted">{t("bktNotConfigured")}</p>
      </div>
    );
  }

  const { hotelName, tokens, css, json, prompt, bookingUrl, deepLinkExample } = loaderData;

  const bookNowSnippet = `<a href="${bookingUrl}" target="_blank" rel="noopener">Book now</a>`;
  const searchFormSnippet = `<form action="${bookingUrl}/rooms" method="get" target="_blank">
  <label>Check-in <input type="date" name="checkin" required></label>
  <label>Check-out <input type="date" name="checkout" required></label>
  <label>Guests <input type="number" name="adults" value="2" min="1"></label>
  <button type="submit">Check availability</button>
</form>`;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the prompt is visible below to copy manually */
    }
  };

  const download = (filename: string, contents: string, type: string) => {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const btn =
    "rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent";

  return (
    <div className="max-w-[760px]">
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("bktTitle")}</h1>
      <p className="mb-6 max-w-[640px] text-[14px] text-muted">
        {t("bktIntroBefore")} <strong>{hotelName}</strong>{t("bktIntroAfter")}
      </p>

      {/* Booking link + deep-link */}
      <section className="mb-5 rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">{t("bktBookingLinkTitle")}</h2>
        <p className="mb-4 max-w-2xl text-[13.5px] text-muted">{t("bktBookingLinkIntro")}</p>

        <div className="mb-4 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-[8px] border border-line-alt bg-surface-alt px-3 py-2 font-mono text-[13px] text-ink">
            {bookingUrl}
          </code>
          <CopyButton text={bookingUrl} label={t("bktCopyLink")} />
          <a href={bookingUrl} target="_blank" rel="noopener" className="flex-none text-[13px] font-semibold text-accent hover:underline">
            {t("bktOpen")}
          </a>
        </div>

        <div className="mb-4 rounded-[10px] bg-surface-alt p-4">
          <div className="mb-1.5 text-[13px] font-semibold text-secondary">{t("bktDeepLinkTitle")}</div>
          <p className="mb-2 text-[12.5px] text-muted">
            {t("bktDeepLinkBefore")} <code className="font-mono">/rooms</code> {t("bktDeepLinkAfter")}
          </p>
          <ul className="mb-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12.5px] text-muted sm:grid-cols-4">
            <li><code className="font-mono text-ink">checkin</code> YYYY-MM-DD</li>
            <li><code className="font-mono text-ink">checkout</code> YYYY-MM-DD</li>
            <li><code className="font-mono text-ink">adults</code> {t("bktParamNumber")}</li>
            <li><code className="font-mono text-ink">childrenAge</code> {t("bktParamAges")}</li>
          </ul>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[8px] border border-line-alt bg-surface px-3 py-2 font-mono text-[12px] text-muted">
              {deepLinkExample}
            </code>
            <CopyButton text={deepLinkExample} />
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-secondary">{t("bktBookNowLabel")}</span>
            <CopyButton text={bookNowSnippet} />
          </div>
          <pre className="overflow-x-auto rounded-[10px] border border-line-alt bg-surface-alt p-3 font-mono text-[12px] text-secondary">
            {bookNowSnippet}
          </pre>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-secondary">
              {t("bktSearchWidgetLabel")}
            </span>
            <CopyButton text={searchFormSnippet} />
          </div>
          <pre className="overflow-x-auto rounded-[10px] border border-line-alt bg-surface-alt p-3 font-mono text-[12px] text-secondary">
            {searchFormSnippet}
          </pre>
          <p className="mt-2 text-[12.5px] text-muted">
            {t("bktWidgetHintBefore")}{" "}
            <a href="/admin/website-widget" className="font-semibold text-accent hover:underline">
              {t("bktWidgetLink")}
            </a>
            .
          </p>
        </div>
      </section>

      {/* Token preview */}
      <section className="mb-5 rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-4 font-serif text-[18px] font-semibold">{t("bktStyleTitle")}</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Swatch label={t("bktSwatchAccent")} value={tokens.accent} />
          <Swatch label={t("bktSwatchAccentHover")} value={tokens.accentDeep} />
          <Swatch label={t("bktSwatchPage")} value={tokens.page} />
          <Swatch label={t("bktSwatchText")} value={tokens.neutrals.ink} />
          <Swatch label={t("bktSwatchSurface")} value={tokens.neutrals.surface} />
          <Swatch label={t("bktSwatchBorder")} value={tokens.neutrals.line} />
        </div>
        <div className="mt-4 border-t border-divider pt-4 text-[13px]">
          <div className="text-secondary">
            <span className="font-semibold">{t("bktHeadings")}</span>{" "}
            <span style={{ fontFamily: tokens.fonts.heading }}>{tokens.fonts.heading.split(",")[0].replace(/"/g, "")}</span>
          </div>
          <div className="mt-1 text-secondary">
            <span className="font-semibold">{t("bktBody")}</span>{" "}
            <span style={{ fontFamily: tokens.fonts.body }}>{tokens.fonts.body.split(",")[0].replace(/"/g, "")}</span>
          </div>
        </div>
      </section>

      {/* AI prompt */}
      <section className="mb-5 rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">{t("bktAiTitle")}</h2>
        <p className="mb-4 max-w-2xl text-[13.5px] text-muted">{t("bktAiIntro")}</p>
        <textarea
          readOnly
          value={prompt}
          rows={10}
          className="mb-3 w-full rounded-[10px] border border-line-alt bg-surface-alt p-3 font-mono text-[12px] text-secondary"
        />
        <button type="button" onClick={copyPrompt} className={btn}>
          {copied ? t("bktCopiedPrompt") : t("bktCopyPrompt")}
        </button>
      </section>

      {/* Downloads */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">{t("bktFilesTitle")}</h2>
        <p className="mb-4 max-w-2xl text-[13.5px] text-muted">
          {t("bktFilesIntroBefore")} <code className="font-mono">brand.css</code> {t("bktFilesIntroMid")}{" "}
          <code className="font-mono">tokens.json</code> {t("bktFilesIntroAfter")}
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => download("brand.css", css, "text/css")} className={btn}>
            {t("bktDownloadCss")}
          </button>
          <button
            type="button"
            onClick={() => download("tokens.json", json, "application/json")}
            className={btn}
          >
            {t("bktDownloadJson")}
          </button>
        </div>
      </section>
    </div>
  );
}
