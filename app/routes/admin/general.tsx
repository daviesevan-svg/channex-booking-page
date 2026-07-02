import { useState } from "react";
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/general";
import { requireAdmin } from "~/lib/auth.server";
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
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">General</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to edit
          settings.
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
      ? "Guests can book any available future date."
      : cutoff === "0"
        ? "Same-day arrivals are accepted until the cut-off time; after that, today's date closes."
        : `Guests must book at least ${cutoff} day${cutoff === "1" ? "" : "s"} before the check-in date.`;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">General</h1>
        {actionData?.ok && !actionData?.slugError && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>

      <Form method="post" className="flex flex-col gap-7 rounded-[14px] border border-line bg-surface p-6">
        {/* Booking link (shortcode) */}
        <section>
          <div className="mb-1 font-serif text-[18px] font-semibold">Booking link</div>
          <p className="mb-3 text-[13.5px] text-muted">
            A short, memorable web address for your booking page, instead of the long id. Use lowercase
            letters, numbers and hyphens. Leave blank to use the id.
          </p>
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
                Live at <code className="rounded bg-chip px-1.5 py-0.5">{host}/{slug}</code> — the long
                id keeps working too.
              </p>
            )
          )}
        </section>

        {/* Theme */}
        <section>
          <div className="mb-1 font-serif text-[18px] font-semibold">Brand colour</div>
          <p className="mb-4 text-[13.5px] text-muted">Sets the accent colour across the booking pages.</p>
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
                <span className="text-[12.5px] font-semibold">Custom</span>
              </span>
            </label>
          </div>

          <div className="mt-4 grid max-w-md grid-cols-1 gap-4">
            <div>
              <div className="mb-1.5 text-[13px] font-semibold text-secondary">Accent colour</div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={validHex ? hex : "#b5651d"}
                  onChange={(e) => setHex(e.target.value)}
                  aria-label="Accent colour"
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
              <div className="mb-1.5 text-[13px] font-semibold text-secondary">Background colour</div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={validBg && bgHex ? bgHex : "#f5f2ec"}
                  onChange={(e) => setBgHex(e.target.value)}
                  aria-label="Background colour"
                  className={pickerCls}
                />
                <input
                  type="text"
                  name="customBg"
                  value={bgHex}
                  onChange={(e) => setBgHex(e.target.value)}
                  placeholder="auto (from accent)"
                  className={hexCls}
                />
                {bgHex && (
                  <button
                    type="button"
                    onClick={() => setBgHex("")}
                    className="text-[12.5px] font-semibold text-muted hover:text-accent"
                  >
                    Auto
                  </button>
                )}
              </div>
            </div>
            <span className="text-[12.5px] text-muted">
              Enter hex codes, then choose <strong>Custom</strong> above. Leave the background blank
              to derive it from the accent. Cards and text stay neutral for readability.
            </span>
          </div>
        </section>

        {/* Currency */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">Currency</div>
          <p className="mb-3 text-[13.5px] text-muted">The currency all prices are shown and charged in.</p>
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
          <div className="mb-1 font-serif text-[18px] font-semibold">Booking lead time</div>
          <p className="mb-4 text-[13.5px] text-muted">
            Stop taking last-minute bookings. Choose how much notice you need before a guest's
            check-in date. Same-day bookings can stay open until a cut-off time; one or more days'
            notice closes at midnight in your timezone.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:max-w-md">
            <label className="block text-[13px] font-semibold text-secondary">
              Property timezone
              <select name="timezone" defaultValue={settings.timezone || "UTC"} className={fieldCls}>
                {timezones.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
              <span className="mt-1 block text-[12px] font-normal text-muted">
                Used to evaluate the same-day cut-off time and the daily midnight boundary.
              </span>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Stop bookings
              <select
                name="bookingCutoffDays"
                value={cutoff}
                onChange={(e) => setCutoff(e.target.value)}
                className={fieldCls}
              >
                <option value="off">No limit — accept any future date</option>
                <option value="0">Same day — stop at a set time</option>
                {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                  <option key={n} value={String(n)}>
                    {n} day{n === 1 ? "" : "s"} before arrival
                  </option>
                ))}
              </select>
            </label>
            {cutoff === "0" && (
              <label className="block text-[13px] font-semibold text-secondary">
                Stop same-day bookings at
                <input
                  type="time"
                  name="bookingCutoffTime"
                  defaultValue={settings.bookingCutoffTime || "18:00"}
                  className={fieldCls}
                />
                <span className="mt-1 block text-[12px] font-normal text-muted">
                  After this local time, today's date can no longer be booked.
                </span>
              </label>
            )}
          </div>
          <p className="mt-3 rounded-[10px] bg-chip px-4 py-2.5 text-[12.5px] text-secondary">{cutoffSummary}</p>
        </section>

        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">Legal links</div>
          <p className="mb-3 text-[13.5px] text-muted">
            Linked from the consent line at checkout. Leave blank to show the wording without a link.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:max-w-md">
            <label className="block text-[13px] font-semibold text-secondary">
              Terms &amp; Conditions URL
              <input
                name="termsUrl"
                type="url"
                defaultValue={settings.termsUrl}
                placeholder="https://yourhotel.com/terms"
                className="mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Privacy Policy URL
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
          <div className="mb-1 font-serif text-[18px] font-semibold">Languages</div>
          <p className="mb-3 text-[13.5px] text-muted">
            Enable the languages guests can switch between. Translate each in the Pages/Rooms
            editors using the language selector. English is always available.
          </p>
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
                  {isDefault && <span className="text-[11px] text-faint">default</span>}
                </label>
              );
            })}
          </div>
        </section>

        {/* Booking mode */}
        <section className="border-t border-divider pt-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">Booking mode</div>
          <p className="mb-3 text-[13.5px] text-muted">
            In <strong>Test mode</strong> checkout simulates the booking and nothing is sent to
            Channex. In <strong>Live mode</strong> real bookings are pushed to Channex.
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
              <span className="block text-[14px] font-semibold text-ink">Enable live bookings</span>
              <span className="block text-[12.5px] text-muted">
                {live
                  ? "Live — real reservations will be created in Channex."
                  : "Test — bookings are simulated only."}
              </span>
            </span>
          </label>
          {live && (
            <div className="mt-3 rounded-[10px] border border-[#e7c9a3] bg-[#fbf2e6] px-4 py-3 text-[12.5px] leading-[1.6] text-[#8a5a23]">
              <strong>Live mode is on.</strong> Every completed checkout will create a real booking
              in Channex. Make sure your Open Channel connection and the outbound booking key are set
              before taking real reservations.
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
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </Form>
    </div>
  );
}
