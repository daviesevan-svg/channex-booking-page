import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/general";
import { adminMeta } from "~/lib/admin-meta";
import { requireAdmin } from "~/lib/auth.server";
import { useAdminT } from "~/lib/admin-i18n";
import { currentPropertyId, getProperty, setPropertySlug } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { DEFAULT_LANG, LANGUAGES } from "~/lib/content";
import { getRates, pricingModeOf } from "~/lib/catalog.server";
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
  // Effective, not stored: data saved before the setting existed derives its
  // mode from the legacy per-rate flags, and the select should show that.
  const pricingMode = pricingModeOf(settings, await getRates(propertyId));
  return {
    configured: true as const,
    settings,
    pricingMode,
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

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navGeneral" });
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

  const { settings, slug, host, envLive, timezones, pricingMode } = loaderData;
  const [live, setLive] = useState(settings.liveBooking ?? envLive);
  // Booking lead-time cutoff: "off" = no limit, "0" = same day (with a time),
  // "1".."7" = require that many days before arrival.
  const [cutoff, setCutoff] = useState<string>(
    settings.bookingCutoffDays == null ? "off" : String(settings.bookingCutoffDays),
  );

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
          <p className="mb-3 text-[13px] text-muted">{t("genBookingLinkHint")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-[10px] bg-chip px-3 py-[11px] font-mono text-[13px] text-secondary">
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
              <p className="mt-2 text-[12px] text-muted">
                {t("genLiveAtPrefix")}{" "}
                <code className="rounded bg-chip px-1.5 py-0.5">{host}/{slug}</code>{" "}
                {t("genLiveAtSuffix")}
              </p>
            )
          )}
        </section>

        {/* Colour and typeface moved to Website → Sections, beside the template
            picker: choosing a design and making it yours is one screen. */}
        <section>
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genBrandColour")}</div>
          <p className="text-[13px] text-muted">
            {t("genBrandMoved")}{" "}
            <Link to="/admin/website/sections" className="font-semibold text-accent hover:underline">
              {t("navSections")}
            </Link>
            .
          </p>
        </section>

        {/* Currency */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genCurrency")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("genCurrencyHint")}</p>
          <select
            name="currency"
            defaultValue={settings.currency || "GBP"}
            className="block w-full max-w-[200px] rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
          >
            {["GBP", "EUR", "USD", "AUD", "CAD", "CHF", "JPY", "NZD", "THB", "TRY"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </section>

        {/* Pricing mode — property-wide, because a channel manager applies sell
            mode to the whole connection; rates can't mix per-room and per-person. */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genPricingMode")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("genPricingModeHint")}</p>
          <div className="grid grid-cols-1 gap-2.5 sm:max-w-md">
            {(["per_room", "per_person"] as const).map((mode) => (
              <label
                key={mode}
                className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3"
              >
                <input type="radio" name="pricingMode" value={mode} defaultChecked={pricingMode === mode} className="mt-1" />
                <span>
                  <span className="block text-[14px] font-semibold text-ink">
                    {mode === "per_room" ? t("genPricingPerRoom") : t("genPricingPerPerson")}
                  </span>
                  <span className="block text-[12px] text-muted">
                    {mode === "per_room" ? t("genPricingPerRoomDesc") : t("genPricingPerPersonDesc")}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* Booking lead time */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genLeadTime")}</div>
          <p className="mb-4 text-[13px] text-muted">{t("genLeadTimeHint")}</p>
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
          <p className="mt-3 rounded-[10px] bg-chip px-4 py-2.5 text-[12px] text-secondary">{cutoffSummary}</p>
        </section>

        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genLegalLinks")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("genLegalLinksHint")}</p>
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
          <p className="mb-3 text-[13px] text-muted">{t("genLanguagesHint")}</p>
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
          <p className="mb-3 text-[13px] text-muted">
            {t("genPropertyTypeHintPrefix")}{" "}
            <strong>{t("genSingleBookableUnit")}</strong>{t("genPropertyTypeHintSuffix")}
          </p>
          <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3">
            <input type="checkbox" name="singleUnit" defaultChecked={settings.singleUnit} className="mt-1" />
            <span>
              <span className="block text-[14px] font-semibold text-ink">{t("genSingleUnitMode")}</span>
              <span className="block text-[12px] text-muted">
                {t("genSingleUnitModeDesc")}
              </span>
            </span>
          </label>
        </section>

        {/* Booking mode */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("genBookingMode")}</div>
          <p className="mb-3 text-[13px] text-muted">
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
              <span className="block text-[12px] text-muted">
                {live ? t("genLiveDesc") : t("genTestDesc")}
              </span>
            </span>
          </label>
          {live && (
            <div className="mt-3 rounded-[10px] border border-[#e7c9a3] bg-[#fbf2e6] px-4 py-3 text-[12px] leading-[1.6] text-[#8a5a23]">
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
