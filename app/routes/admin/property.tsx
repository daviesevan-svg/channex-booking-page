import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/property";
import { Field, FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getProperty, renameProperty, setPropertyPublic } from "~/lib/properties.server";
import { DEFAULT_LANG, langParam, pickLang, VR_AMENITY_ENUMS, VR_AMENITY_KEYS } from "~/lib/content";
import { getOverridesRaw, getSettings, patchSettings, savePropertyMeta, saveOverrides } from "~/lib/overrides.server";
import { uploadPropertyCoverImage, uploadPropertyLogo } from "~/lib/images.server";
import { checkGoogleReadiness } from "~/lib/google-readiness.server";
import { AmenitiesPicker } from "~/components/amenities-picker";
import { COUNTRIES } from "~/lib/countries";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const [overrides, settings, googleReadiness, property] = await Promise.all([
    getOverridesRaw(propertyId, lang),
    getSettings(propertyId),
    checkGoogleReadiness(propertyId),
    getProperty(propertyId),
  ]);
  return {
    configured: true as const,
    propertyId,
    lang,
    overrides,
    settings,
    googleReadiness,
    isPublic: Boolean(property?.public),
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
  // Property cover photo (global; shown on Collections cards).
  const coverUpload = form.get("coverUpload");
  if (coverUpload instanceof File && coverUpload.size > 0) {
    try {
      await patchSettings(propertyId, { coverImage: await uploadPropertyCoverImage(propertyId, coverUpload) });
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Cover image upload failed." };
    }
  } else if (form.get("removeCover") === "1") {
    await patchSettings(propertyId, { coverImage: "" });
  }
  // Property logo (global; shown in the guest booking header).
  const logoUpload = form.get("logoUpload");
  if (logoUpload instanceof File && logoUpload.size > 0) {
    try {
      await patchSettings(propertyId, { logoImage: await uploadPropertyLogo(propertyId, logoUpload) });
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Logo upload failed." };
    }
  } else if (form.get("removeLogo") === "1") {
    await patchSettings(propertyId, { logoImage: "" });
  }
  // Property amenities (global; shown to guests + sent to Google). Only known
  // vocabulary keys / enum values are stored. Unit size is a Google VR go-live
  // requirement for single-unit properties; blank leaves the stored value.
  const vrAmenities = form.getAll("amenity").map(String).filter((k) => VR_AMENITY_KEYS.has(k));
  const vrAmenityOptions: Record<string, string> = {};
  for (const def of VR_AMENITY_ENUMS) {
    const v = String(form.get(`enum_${def.key}`) ?? "");
    if (def.options.includes(v)) vrAmenityOptions[def.key] = v;
  }
  const count = (name: string): number | undefined => {
    const raw = String(form.get(name) ?? "").trim();
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  await patchSettings(propertyId, {
    vrAmenities,
    vrAmenityOptions,
    vrBedrooms: count("vrBedrooms"),
    vrBathrooms: count("vrBathrooms"),
    vrBeds: count("vrBeds"),
  });
  // Keep the property switcher / list label in sync with the hotel name. That
  // registry label is a single canonical name, so only the default-language
  // hotel name drives it — editing a translation doesn't rename the property.
  const hotelName = String(form.get("hotelName") ?? "").trim();
  if (lang === DEFAULT_LANG && hotelName) await renameProperty(propertyId, hotelName);
  // Public listing (registry flag): shown on the home directory + required for
  // the Google feed. Mirrors the toggle on the Properties page.
  await setPropertyPublic(propertyId, form.get("public") === "on");
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

  const { overrides, settings, googleReadiness, isPublic, host, lang } = loaderData;

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

      {actionData && "error" in actionData && actionData.error && (
        <p className="mb-4 rounded-[10px] bg-[#fdecea] px-4 py-2.5 text-[13px] font-semibold text-[#c0392b]">
          {actionData.error}
        </p>
      )}

      <Form
        method="post"
        encType="multipart/form-data"
        key={lang}
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <Field name="hotelName" label="Hotel name" value={overrides.hotelName} placeholder="Spilman Hotel" />

        {/* Public listing (registry flag, global — not per-language). Same
            control as the Properties page, surfaced here where it's edited. */}
        <label className="flex items-start gap-2.5 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3">
          <input type="checkbox" name="public" defaultChecked={isPublic} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
          <span className="text-[13.5px]">
            <span className="font-semibold text-ink">Listed publicly</span>
            <span className="mt-0.5 block text-[12.5px] text-muted">
              Shows on the home directory and makes the property eligible for Google Hotels. Turn off
              to keep it bookable by direct link only.
            </span>
          </span>
        </label>

        {/* Logo — replaces the diamond + name lockup in the guest booking
            header. Global (not per-language). */}
        <div>
          <div className="mb-1.5 text-[13px] font-semibold text-secondary">Logo</div>
          {settings.logoImage ? (
            <div className="mb-2 flex items-center gap-3">
              <div className="flex h-16 w-44 flex-none items-center justify-center rounded-[10px] border border-line-alt bg-chip px-3">
                <img src={settings.logoImage} alt="Property logo" className="max-h-12 max-w-full object-contain" />
              </div>
              <label className="flex items-center gap-2 text-[13px] text-secondary">
                <input type="checkbox" name="removeLogo" value="1" /> Remove
              </label>
            </div>
          ) : (
            <p className="mb-2 text-[12.5px] text-muted">
              No logo set — the booking pages show your hotel name as text. Upload one to replace it.
            </p>
          )}
          <input
            type="file"
            name="logoUpload"
            accept="image/*"
            className="block w-full text-[13px] text-secondary file:mr-3 file:rounded-[8px] file:border file:border-line-alt file:bg-surface file:px-3 file:py-1.5 file:text-[13px] file:font-semibold file:text-secondary hover:file:border-accent"
          />
          <p className="mt-1 text-[11px] text-faint">
            Shown ~40px tall in the booking header — a wide wordmark on a transparent background (PNG/WebP) works best.
          </p>
        </div>

        {/* Cover photo — the property's image on Collections cards. Global (not
            per-language). */}
        <div>
          <div className="mb-1.5 text-[13px] font-semibold text-secondary">Cover photo</div>
          {settings.coverImage ? (
            <div className="mb-2 flex items-center gap-3">
              <img
                src={settings.coverImage}
                alt="Property cover"
                className="h-20 w-32 flex-none rounded-[10px] border border-line-alt object-cover"
              />
              <label className="flex items-center gap-2 text-[13px] text-secondary">
                <input type="checkbox" name="removeCover" value="1" /> Remove
              </label>
            </div>
          ) : (
            <p className="mb-2 text-[12.5px] text-muted">
              No cover set — collection cards fall back to a room photo. Upload one for a reliable image.
            </p>
          )}
          <input
            type="file"
            name="coverUpload"
            accept="image/*"
            className="block w-full text-[13px] text-secondary file:mr-3 file:rounded-[8px] file:border file:border-line-alt file:bg-surface file:px-3 file:py-1.5 file:text-[13px] file:font-semibold file:text-secondary hover:file:border-accent"
          />
          <p className="mt-1 text-[11px] text-faint">JPG/PNG/WebP, up to 8MB. Uploaded to your R2 bucket.</p>
        </div>
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

        {/* Amenities (global; shown to guests + sent to Google, which only
            accepts its fixed vocabulary — free-text room facilities stay
            guest-display-only). */}
        <section className="border-t border-divider pt-5">
          <div className="mb-1 text-[15px] font-semibold">Amenities</div>
          <p className="mb-3 text-[13px] text-muted">
            What the property offers. Shown to guests in their language and used to build your
            Google listing. Room-specific amenities are set per room type on the Rooms page.
          </p>
          <AmenitiesPicker selected={settings.vrAmenities ?? []} />
          <div className="mt-4 flex flex-wrap gap-4">
            {VR_AMENITY_ENUMS.map((def) => (
              <label key={def.key} className="block text-[13px] font-semibold text-secondary">
                {def.label}
                <select name={`enum_${def.key}`} defaultValue={settings.vrAmenityOptions?.[def.key] ?? ""} className={`${FIELD_INPUT} cursor-pointer`}>
                  <option value="">Not specified</option>
                  {def.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {/* Unit size — single-unit properties only; required before Google
              publishes a Vacation Rentals listing. */}
          {settings.singleUnit && (
            <div className="mt-5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-secondary">Property size</span>
                {settings.vrBedrooms == null || settings.vrBathrooms == null || settings.vrBeds == null ? (
                  <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[12px] font-semibold text-amber-800">
                    Required for Google Vacation Rentals
                  </span>
                ) : (
                  <span className="rounded-full bg-[#e8f0e6] px-2.5 py-0.5 text-[12px] font-semibold text-[#3f7a52]">
                    ✓ Complete
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-4">
                {[
                  { name: "vrBedrooms", label: "Bedrooms", value: settings.vrBedrooms, step: "1", hint: "0 for a studio" },
                  { name: "vrBathrooms", label: "Bathrooms", value: settings.vrBathrooms, step: "0.5", hint: "Half counts — e.g. 1.5" },
                  { name: "vrBeds", label: "Beds", value: settings.vrBeds, step: "1", hint: "Physical beds, not guests — one double bed = 1" },
                ].map((f) => (
                  <label key={f.name} className="block text-[13px] font-semibold text-secondary">
                    {f.label}
                    <input type="number" name={f.name} min={0} step={f.step} defaultValue={f.value ?? ""} className={`${FIELD_INPUT} w-28`} />
                    {f.hint && <span className="mt-1 block text-[11px] font-normal text-faint">{f.hint}</span>}
                  </label>
                ))}
              </div>
            </div>
          )}
        </section>

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
