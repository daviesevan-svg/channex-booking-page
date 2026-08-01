// Brand colour and typeface, for the design screen.
//
// These sat on Settings → General, a page about currency and lead times, while
// the template picker sat on Website → Sections. Choosing a design and making it
// yours was two screens in two sections of the admin, so they're together now.
//
// The typeface picker is new: a property's `themeFont` was only ever writable
// through the AI paste-back flow on the widget page, so a hotel that didn't use
// that had no way to change its type at all.

import { useState } from "react";
import { Form } from "react-router";

import { DEFAULT_THEME, FONT_PAIRS, THEMES } from "~/lib/content";
import type { SiteSettings } from "~/lib/content";
import { useAdminT } from "~/lib/admin-i18n";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function BrandPanel({
  settings,
  font,
  onFont,
  saving,
  saved,
}: {
  settings: SiteSettings;
  /** The pairing currently SHOWN — the saved one until the operator picks another,
   *  so the preview beside this can follow along before anything is written. */
  font: string;
  onFont: (id: string) => void;
  saving: boolean;
  saved: boolean;
}) {
  const t = useAdminT();
  const activeTheme = settings.theme ?? DEFAULT_THEME;
  const [hex, setHex] = useState(settings.customColor || "#b5651d");
  const [bgHex, setBgHex] = useState(settings.customBg || "");
  const validHex = HEX.test(hex);

  const picker = "h-10 w-12 cursor-pointer rounded-[8px] border border-line-alt bg-surface-alt p-1";
  const hexField =
    "w-36 rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[9px] font-mono text-[14px] text-ink outline-none focus:border-accent";

  return (
    <Form method="post" className="mb-6 rounded-[14px] border border-line bg-surface p-5">
      <input type="hidden" name="op" value="brand" />
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="font-serif text-[18px] font-semibold">{t("brandTitle")}</div>
        {saved && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            {t("saved")}
          </span>
        )}
      </div>
      <p className="mb-4 text-[13px] leading-[1.55] text-muted">{t("brandIntro")}</p>

      <div className="mb-2 text-[13px] font-semibold text-secondary">{t("genBrandColour")}</div>
      <div className="mb-4 flex flex-wrap gap-3">
        {THEMES.map((theme) => (
          <label key={theme.id} className="cursor-pointer">
            <input
              type="radio"
              name="theme"
              value={theme.id}
              defaultChecked={activeTheme === theme.id}
              className="peer sr-only"
            />
            <span className="flex w-[92px] flex-col items-center gap-2 rounded-[12px] border-2 border-line-alt p-3 transition-colors peer-checked:border-accent peer-checked:bg-field-hover">
              <span className="h-8 w-8 rounded-full" style={{ background: theme.accent }} />
              <span className="text-[12px] font-semibold">{theme.label}</span>
            </span>
          </label>
        ))}
        <label className="cursor-pointer">
          <input
            type="radio"
            name="theme"
            value="custom"
            defaultChecked={activeTheme === "custom"}
            className="peer sr-only"
          />
          <span className="flex w-[92px] flex-col items-center gap-2 rounded-[12px] border-2 border-line-alt p-3 transition-colors peer-checked:border-accent peer-checked:bg-field-hover">
            <span
              className="h-8 w-8 rounded-full"
              style={{
                background: validHex ? hex : "conic-gradient(red,orange,gold,green,blue,violet,red)",
              }}
            />
            <span className="text-[12px] font-semibold">{t("genCustom")}</span>
          </span>
        </label>
      </div>

      <div className="mb-5 grid max-w-md grid-cols-1 gap-3">
        <div>
          <div className="mb-1.5 text-[13px] font-semibold text-secondary">{t("genAccentColour")}</div>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={validHex ? hex : "#b5651d"}
              onChange={(e) => setHex(e.target.value)}
              aria-label={t("genAccentColour")}
              className={picker}
            />
            <input
              type="text"
              name="customColor"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              placeholder="#b5651d"
              className={hexField}
            />
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-semibold text-secondary">
            {t("genBackgroundColour")}
          </div>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={HEX.test(bgHex) ? bgHex : "#f5f2ec"}
              onChange={(e) => setBgHex(e.target.value)}
              aria-label={t("genBackgroundColour")}
              className={picker}
            />
            <input
              type="text"
              name="customBg"
              value={bgHex}
              onChange={(e) => setBgHex(e.target.value)}
              placeholder={t("genAutoFromAccent")}
              className={hexField}
            />
            {bgHex && (
              <button
                type="button"
                onClick={() => setBgHex("")}
                className="text-[12px] font-semibold text-muted hover:text-accent"
              >
                {t("genAuto")}
              </button>
            )}
          </div>
        </div>
        <span className="text-[12px] text-muted">
          {t("genHexHintPrefix")} <strong>{t("genCustom")}</strong> {t("genHexHintSuffix")}
        </span>
      </div>

      {/* Typeface. A curated list, not a font field: every pairing here is one we
          actually load, so a hotel can't pick a family nobody has. */}
      <div className="mb-1.5 text-[13px] font-semibold text-secondary">{t("brandTypeface")}</div>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FONT_PAIRS.map((pair) => (
          <label key={pair.id} className="cursor-pointer">
            <input
              type="radio"
              name="themeFont"
              value={pair.id}
              checked={font === pair.id}
              onChange={() => onFont(pair.id)}
              className="peer sr-only"
            />
            <span className="block rounded-[12px] border-2 border-line-alt p-3 transition-colors peer-checked:border-accent peer-checked:bg-field-hover">
              {/* Set in the pairing itself, so the choice shows what it does.
                  Only the default pair is guaranteed loaded in the admin, so the
                  rest fall back to their own stack — still indicative. */}
              <span
                className="block text-[17px] font-semibold"
                style={{ fontFamily: pair.heading }}
              >
                {t("brandTypeSample")}
              </span>
              <span className="mt-0.5 block text-[12px] text-muted" style={{ fontFamily: pair.body }}>
                {pair.label}
              </span>
            </span>
          </label>
        ))}
      </div>

      <button
        type="submit"
        disabled={saving}
        className="cursor-pointer rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
      >
        {t("brandSave")}
      </button>
    </Form>
  );
}
