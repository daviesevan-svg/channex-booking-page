import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/property";
import { Field, FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, renameProperty } from "~/lib/properties.server";
import { DEFAULT_LANG, langParam, pickLang } from "~/lib/content";
import { getOverridesRaw, getSettings, savePropertyMeta, saveOverrides } from "~/lib/overrides.server";
import { checkGoogleReadiness } from "~/lib/google-readiness.server";
import { COUNTRIES } from "~/lib/countries";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const [overrides, settings, googleReadiness] = await Promise.all([
    getOverridesRaw(propertyId, lang),
    getSettings(propertyId),
    checkGoogleReadiness(propertyId),
  ]);
  return {
    configured: true as const,
    propertyId,
    lang,
    overrides,
    settings,
    googleReadiness,
    host: new URL(request.url).host,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  const form = await request.formData();
  const lang = pickLang(String(form.get("lang") ?? ""));
  // Guest-facing copy is localized (per language); the location / check-in /
  // Google fields are global property settings (merged so the rest is untouched).
  await saveOverrides(propertyId, lang, Object.fromEntries(form));
  await savePropertyMeta(propertyId, form);
  // Keep the property switcher / list label in sync with the hotel name. That
  // registry label is a single canonical name, so only the default-language
  // hotel name drives it — editing a translation doesn't rename the property.
  const hotelName = String(form.get("hotelName") ?? "").trim();
  if (lang === DEFAULT_LANG && hotelName) await renameProperty(propertyId, hotelName);
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Property details" }];
}

export default function AdminProperty({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Property details</h1>
        <p className="text-[15px] text-secondary">
          Add a property on the{" "}
          <a href="/admin/properties" className="font-semibold text-accent hover:underline">
            Properties
          </a>{" "}
          page to get started.
        </p>
      </div>
    );
  }

  const { overrides, settings, googleReadiness, host, lang } = loaderData;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Property details</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">
        The hotel details guests see across the booking engine.
      </p>

      <Form
        method="post"
        key={lang}
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <Field name="hotelName" label="Hotel name" value={overrides.hotelName} placeholder="Spilman Hotel" />
        <Field
          name="propertyType"
          label="Property type"
          value={overrides.propertyType}
          placeholder="Boutique hotel, Apartment, Guesthouse…"
          hint="Short label shown on collection pages. Leave blank to auto-label (Apartment for single-unit, otherwise Hotel)."
        />
        <Field name="description" label="Description" value={overrides.description} textarea rows={4} />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field name="phone" label="Phone" value={overrides.phone} placeholder="+44 …" />
          <Field name="email" label="Email" value={overrides.email} placeholder="stay@hotel.com" />
        </div>

        {/* Check-in / check-out times (global; shown to guests + Google). */}
        <section className="border-t border-divider pt-5">
          <div className="mb-1 text-[15px] font-semibold">Check-in &amp; check-out</div>
          <p className="mb-3 text-[13px] text-muted">
            Shown to guests and used in Google structured data. Defaults to 3:00 PM / 11:00 AM.
          </p>
          <div className="flex flex-wrap gap-4">
            <label className="block text-[13px] font-semibold text-secondary">
              Check-in from
              <input type="time" name="checkinTime" defaultValue={settings.checkinTime || "15:00"} className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Check-out by
              <input type="time" name="checkoutTime" defaultValue={settings.checkoutTime || "11:00"} className={FIELD_INPUT} />
            </label>
          </div>
        </section>

        {/* Structured location (global; powers Google matching). */}
        <section className="border-t border-divider pt-5">
          <div className="mb-1 text-[15px] font-semibold">Location</div>
          <p className="mb-3 text-[13px] text-muted">
            The address guests see and the map coordinates used to match this property in the Google
            Hotel List Feed.
          </p>
          <label className="mb-3 block text-[13px] font-semibold text-secondary">
            Street
            <input name="address" defaultValue={overrides.address} placeholder="123 High Street" className={FIELD_INPUT} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              City
              <input name="addressCity" defaultValue={settings.addressCity} className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Region / state
              <input name="addressRegion" defaultValue={settings.addressRegion} className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Postal code
              <input name="addressPostalCode" defaultValue={settings.addressPostalCode} className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Country
              <select name="addressCountry" defaultValue={settings.addressCountry ?? ""} className={`${FIELD_INPUT} cursor-pointer`}>
                <option value="">Select a country…</option>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Latitude
              <input name="latitude" defaultValue={settings.latitude} placeholder="51.8576" className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Longitude
              <input name="longitude" defaultValue={settings.longitude} placeholder="-4.3121" className={FIELD_INPUT} />
            </label>
          </div>
        </section>

        {/* Google Hotels (global). */}
        <section className="border-t border-divider pt-5">
          <div className="mb-1 text-[15px] font-semibold">Google Hotels</div>
          <p className="mb-3 text-[13px] text-muted">
            Emit Google Hotel price structured data on your room, results and checkout pages so your
            direct rates can appear in Google's Free Booking Links.
          </p>
          <p className="mb-3 text-[12.5px] text-muted">
            Hotel List Feed (give this URL to Google Hotel Center):{" "}
            <code className="rounded bg-chip px-1.5 py-0.5">
              {host ? `https://${host}` : ""}/feeds/google-hotels.xml
            </code>
          </p>

          {/* Feed readiness — Google rejects/drops listings with missing content. */}
          {googleReadiness.missingRequired.length > 0 ? (
            <div className="mb-3 rounded-[10px] border border-[#e7b4a8] bg-[#fbeae6] px-4 py-3 text-[12.5px] leading-[1.6] text-[#9a3b27]">
              <strong>Not in the Google feed yet</strong> — add the required content above (Google
              won't process a listing that's missing these):
              <ul className="mt-1.5 list-disc pl-5">
                {googleReadiness.missingRequired.map((m) => (
                  <li key={m.field}>{m.label}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mb-3 rounded-[10px] border border-[#bcd9c2] bg-[#eaf3ec] px-4 py-3 text-[12.5px] font-medium text-[#3f7a52]">
              ✓ Required content complete — this property is included in the Google feed.
            </div>
          )}
          {googleReadiness.missingRecommended.length > 0 && (
            <div className="mb-3 rounded-[10px] border border-[#e7d3a3] bg-[#fbf4e6] px-4 py-3 text-[12.5px] leading-[1.6] text-[#8a6a23]">
              <strong>Recommended</strong> — improves matching &amp; quality, but won't block the feed:
              <ul className="mt-1.5 list-disc pl-5">
                {googleReadiness.missingRecommended.map((m) => (
                  <li key={m.field}>{m.label}</li>
                ))}
              </ul>
            </div>
          )}

          <label className="mb-3 flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3">
            <input
              type="checkbox"
              name="googleStructuredData"
              defaultChecked={settings.googleStructuredData !== false}
              className="mt-1"
            />
            <span>
              <span className="block text-[14px] font-semibold text-ink">Emit structured data</span>
              <span className="block text-[12.5px] text-muted">
                Adds schema.org <code>Hotel</code> price JSON-LD to guest pages.
              </span>
            </span>
          </label>
        </section>

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </Form>
    </div>
  );
}
