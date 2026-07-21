import { useState } from "react";
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/general";
import { requireAdmin } from "~/lib/auth.server";
import { useAdminT } from "~/lib/admin-i18n";
import { currentPropertyId, getProperty, setPropertySlug } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { DEFAULT_LANG, DEFAULT_THEME, LANGUAGES, THEMES } from "~/lib/content";
import { getSettings, saveSettings } from "~/lib/overrides.server";

// A common-zone fallback for runtimes without Intl.supportedValuesOf.
const FALLBACK_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Athens",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function supportedTimezones(): string[] {
  const sv = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof sv !== "function") return FALLBACK_TIMEZONES;
  try {
    const zones = sv("timeZone");
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    return FALLBACK_TIMEZONES;
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const settings = await getSettings(propertyId);
  const ref = await getProperty(propertyId);
  return {
    configured: true as const,
    settings,
    slug: ref?.slug ?? "",
    propertyId,
    host: new URL(request.url).host,
    envLive: getConfig().allowLiveBooking,
    timezones: supportedTimezones(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  const form = await request.formData();
  await saveSettings(propertyId, form);
  // The shortcode lives on the property registry (globally unique), not the
  // per-property settings blob — save it separately and surface any clash.
  const slugRes = await setPropertySlug(propertyId, String(form.get("slug") ?? ""));
  if ("error" in slugRes) return { ok: true as const, slugError: slugRes.error };
  return { ok: true as const };
}

export function meta() {
  return [{ title: "Admin · General" }];
}

export default function AdminGeneral({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const t = useAdminT();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("genTitle")}</h1>
        <p className="text-[15px] text-secondary">
          {t("genSetPropertyIdPrefix")}{" "}
          <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code>{" "}
          {t("genSetPropertyIdSuffix")}
        </p>
      </div>
    );
  }

  const { settings, slug, host, envLive, timezones } = loaderData;
  const activeTheme = settings.theme ?? DEFAULT_THEME;
  const [live, setLive] = useState(settings.liveBooking ?? envLive);
  // Booking lead-time cutoff: "off" = no limit, "0" = same day (with a time),
  // "1".."7" = require that many days before arrival.
  const [cutoff, setCutoff] = useState<string>(
    settings.bookingCutoffDays == null ? "off" : String(settings.bookingCutoffDays),
  );
  const [hex, setHex] = useState(settings.customColor || "#b5651d");
  const validHex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex);
  const [bgHex, setBgHex] = useState(settings.customBg || "");
  const validBg = bgHex === "" || /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(bgHex);

  const pickerCls = "h-10 w-12 cursor-pointer rounded-[8px] border border-line-alt bg-surface-alt p-1";
  const hexCls =
    "w-36 rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[9px] font-mono text-[14px] text-ink outline-none focus:border-accent";
  const fieldCls =
    "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent";
  const cutoffSummary =
    cutoff === "off"
      ? t("genSummaryNoLimit")
      : cutoff === "0"
        ? t("genSummarySameDay")
        : cutoff === "1"
          ? t("genSummaryDayBefore")
          : t("genSummaryDaysBefore", { n: cutoff });

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{t("genTitle")}</h1>
        {actionData?.ok && !actionData?.slugError && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            {t("saved")}
          </span>
        )}
      </div>

      <Form method="post" className="flex flex-col gap-7 rounded-[14px] border border-line bg-surface p-6">
        {/* Booking link (shortcode) */}
        <section>
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genBookingLink")}</div>
          <p className="mb-3 text-[13.5px] text-muted">{t("genBookingLinkHint")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-[10px] bg-chip px-3 py-[11px] font-mono text-[13.5px] text-secondary">
              {host}/
            </span>
            <input
              name="slug"
              defaultValue={slug}
              placeholder="spilmanhotel"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-[200px] flex-1 rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] font-mono text-[15px] text-ink outline-none focus:border-accent"
            />
          </div>
          {actionData?.slugError ? (
            <p className="mt-2 text-[13px] text-red-600">{actionData.slugError}</p>
          ) : (
            slug && (
              <p className="mt-2 text-[12.5px] text-muted">
                {t("genLiveAtPrefix")}{" "}
                <code className="rounded bg-chip px-1.5 py-0.5">{host}/{slug}</code>{" "}
                {t("genLiveAtSuffix")}
              </p>
            )
          )}
        </section>

        {/* Theme */}
        <section>
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genBrandColour")}</div>
          <p className="mb-4 text-[13.5px] text-muted">{t("genBrandColourHint")}</p>
          <div className="flex flex-wrap gap-3">
            {THEMES.map((t) => (
              <label key={t.id} className="cursor-pointer">
                <input
                  type="radio"
                  name="theme"
                  value={t.id}
                  defaultChecked={activeTheme === t.id}
                  className="peer sr-only"
                />
                <span className="flex w-[92px] flex-col items-center gap-2 rounded-[12px] border-2 border-line-alt p-3 transition-colors peer-checked:border-accent peer-checked:bg-field-hover">
                  <span className="h-8 w-8 rounded-full" style={{ background: t.accent }} />
                  <span className="text-[12.5px] font-semibold">{t.label}</span>
                </span>
              </label>
            ))}

            {/* Custom colour */}
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
                  style={{ background: validHex ? hex : "conic-gradient(red,orange,gold,green,blue,violet,red)" }}
                />
                <span className="text-[12.5px] font-semibold">{t("genCustom")}</span>
              </span>
            </label>
          </div>

          <div className="mt-4 grid max-w-md grid-cols-1 gap-4">
            <div>
              <div className="mb-1.5 text-[13px] font-semibold text-secondary">{t("genAccentColour")}</div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={validHex ? hex : "#b5651d"}
                  onChange={(e) => setHex(e.target.value)}
                  aria-label={t("genAccentColour")}
                  className={pickerCls}
                />
                <input
                  type="text"
                  name="customColor"
                  value={hex}
                  onChange={(e) => setHex(e.target.value)}
                  placeholder="#b5651d"
                  className={hexCls}
                />
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[13px] font-semibold text-secondary">{t("genBackgroundColour")}</div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={validBg && bgHex ? bgHex : "#f5f2ec"}
                  onChange={(e) => setBgHex(e.target.value)}
                  aria-label={t("genBackgroundColour")}
                  className={pickerCls}
                />
                <input
                  type="text"
                  name="customBg"
                  value={bgHex}
                  onChange={(e) => setBgHex(e.target.value)}
                  placeholder={t("genAutoFromAccent")}
                  className={hexCls}
                />
                {bgHex && (
                  <button
                    type="button"
                    onClick={() => setBgHex("")}
                    className="text-[12.5px] font-semibold text-muted hover:text-accent"
                  >
                    {t("genAuto")}
                  </button>
                )}
              </div>
            </div>
            <span className="text-[12.5px] text-muted">
              {t("genHexHintPrefix")} <strong>{t("genCustom")}</strong> {t("genHexHintSuffix")}
            </span>
          </div>
        </section>

        {/* Currency */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genCurrency")}</div>
          <p className="mb-3 text-[13.5px] text-muted">{t("genCurrencyHint")}</p>
          <select
            name="currency"
            defaultValue={settings.currency || "GBP"}
            className="block w-full max-w-[200px] rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
          >
            {["GBP", "EUR", "USD", "AUD", "CAD", "CHF", "JPY", "NZD"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </section>

        {/* Booking lead time */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genLeadTime")}</div>
          <p className="mb-4 text-[13.5px] text-muted">{t("genLeadTimeHint")}</p>
          <div className="grid grid-cols-1 gap-4 sm:max-w-md">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("genPropertyTimezone")}
              <select name="timezone" defaultValue={settings.timezone || "UTC"} className={fieldCls}>
                {timezones.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
              <span className="mt-1 block text-[12px] font-normal text-muted">
                {t("genTimezoneHint")}
              </span>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("genStopBookings")}
              <select
                name="bookingCutoffDays"
                value={cutoff}
                onChange={(e) => setCutoff(e.target.value)}
                className={fieldCls}
              >
                <option value="off">{t("genCutoffNoLimit")}</option>
                <option value="0">{t("genCutoffSameDay")}</option>
                {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                  <option key={n} value={String(n)}>
                    {n === 1 ? t("genCutoffDayBefore") : t("genCutoffDaysBefore", { n })}
                  </option>
                ))}
              </select>
            </label>
            {cutoff === "0" && (
              <label className="block text-[13px] font-semibold text-secondary">
                {t("genStopSameDayAt")}
                <input
                  type="time"
                  name="bookingCutoffTime"
                  defaultValue={settings.bookingCutoffTime || "18:00"}
                  className={fieldCls}
                />
                <span className="mt-1 block text-[12px] font-normal text-muted">
                  {t("genSameDayCutoffHint")}
                </span>
              </label>
            )}
          </div>
          <p className="mt-3 rounded-[10px] bg-chip px-4 py-2.5 text-[12.5px] text-secondary">{cutoffSummary}</p>
        </section>

        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genLegalLinks")}</div>
          <p className="mb-3 text-[13.5px] text-muted">{t("genLegalLinksHint")}</p>
          <div className="grid grid-cols-1 gap-4 sm:max-w-md">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("genTermsUrl")}
              <input
                name="termsUrl"
                type="url"
                defaultValue={settings.termsUrl}
                placeholder="https://yourhotel.com/terms"
                className="mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("genPrivacyUrl")}
              <input
                name="privacyUrl"
                type="url"
                defaultValue={settings.privacyUrl}
                placeholder="https://yourhotel.com/privacy"
                className="mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
              />
            </label>
          </div>
        </section>

        {/* Languages */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genLanguages")}</div>
          <p className="mb-3 text-[13.5px] text-muted">{t("genLanguagesHint")}</p>
          <div className="flex flex-wrap gap-2.5">
            {LANGUAGES.map((l) => {
              const isDefault = l.code === DEFAULT_LANG;
              const checked = isDefault || (settings.languages ?? []).includes(l.code);
              return (
                <label
                  key={l.code}
                  className="flex items-center gap-2 rounded-[10px] border border-line-alt px-3 py-2 text-[14px] font-medium"
                >
                  <input
                    type="checkbox"
                    name="languages"
                    value={l.code}
                    defaultChecked={checked}
                    disabled={isDefault}
                  />
                  {l.label}
                  {isDefault && <span className="text-[11px] text-faint">{t("genDefault")}</span>}
                </label>
              );
            })}
          </div>
        </section>

        {/* Property type */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genPropertyType")}</div>
          <p className="mb-3 text-[13.5px] text-muted">
            {t("genPropertyTypeHintPrefix")}{" "}
            <strong>{t("genSingleBookableUnit")}</strong>{t("genPropertyTypeHintSuffix")}
          </p>
          <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3">
            <input type="checkbox" name="singleUnit" defaultChecked={settings.singleUnit} className="mt-1" />
            <span>
              <span className="block text-[14px] font-semibold text-ink">{t("genSingleUnitMode")}</span>
              <span className="block text-[12.5px] text-muted">
                {t("genSingleUnitModeDesc")}
              </span>
            </span>
          </label>
        </section>

        {/* Booking mode */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genBookingMode")}</div>
          <p className="mb-3 text-[13.5px] text-muted">
            {t("genBookingModeIn")} <strong>{t("genTestMode")}</strong> {t("genBookingModeHintMid")}{" "}
            <strong>{t("genLiveMode")}</strong> {t("genBookingModeHintEnd")}
          </p>
          <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3">
            <input
              type="checkbox"
              name="liveBooking"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block text-[14px] font-semibold text-ink">{t("genEnableLiveBookings")}</span>
              <span className="block text-[12.5px] text-muted">
                {live ? t("genLiveDesc") : t("genTestDesc")}
              </span>
            </span>
          </label>
          {live && (
            <div className="mt-3 rounded-[10px] border border-[#e7c9a3] bg-[#fbf2e6] px-4 py-3 text-[12.5px] leading-[1.6] text-[#8a5a23]">
              <strong>{t("genLiveWarningTitle")}</strong> {t("genLiveWarningBody")}
            </div>
          )}
        </section>

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? t("saving") : t("genSaveSettings")}
          </button>
        </div>
      </Form>
    </div>
  );
}
