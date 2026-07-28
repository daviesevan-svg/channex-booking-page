import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/facilities";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import {
  DEFAULT_LANG,
  facilityLabelKey,
  langParam,
  normalizeFacilities,
  pickLang,
  PROPERTY_FACILITIES,
} from "~/lib/content";
import {
  getFacilitiesExtra,
  getFacilitiesExtraRaw,
  getSettings,
  patchSettings,
  saveFacilitiesExtra,
} from "~/lib/overrides.server";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminLang, useAdminT } from "~/lib/admin-i18n";
import { makeTranslator } from "~/lib/i18n";

/** Google VR amenity key → our facility key. Only unambiguous pairs: the copy
 *  button is a shortcut, not a mapping we want to argue about later. */
const FROM_VR: Record<string, string> = {
  wifi: "wifi",
  ac: "airConditioning",
  gym_fitness_equipment: "gym",
  hot_tub: "hotTub",
  pets_allowed: "petFriendly",
  wheelchair_accessible: "accessible",
  smoking_free_property: "nonSmoking",
  beach_access: "beachAccess",
  airport_shuttle: "airportShuttle",
  free_breakfast: "breakfast",
  child_friendly: "familyFriendly",
  patio: "terrace",
};

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const [settings, extra, baseExtra] = await Promise.all([
    getSettings(propertyId),
    getFacilitiesExtraRaw(propertyId, lang),
    lang === DEFAULT_LANG ? Promise.resolve([]) : getFacilitiesExtra(propertyId, DEFAULT_LANG),
  ]);
  const chosen = settings.facilities ?? [];
  return {
    configured: true as const,
    lang,
    chosen,
    extra,
    baseExtra,
    // Only offer the shortcut when there's something to copy that isn't ticked.
    copyable: (settings.vrAmenities ?? [])
      .map((k) => FROM_VR[k])
      .filter((k): k is string => Boolean(k) && !chosen.includes(k)).length,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };

  const form = await request.formData();
  const lang = pickLang(String(form.get("lang") ?? ""));

  if (String(form.get("op")) === "copyFromGoogle") {
    const settings = await getSettings(propertyId);
    const add = (settings.vrAmenities ?? []).map((k) => FROM_VR[k]).filter(Boolean);
    await patchSettings(propertyId, {
      facilities: normalizeFacilities([...(settings.facilities ?? []), ...add]),
    });
    return { ok: true as const };
  }

  // The tick list is language-independent (it maps to translated labels), so it
  // saves the same set whichever language tab you're on. Only the free-text
  // lines below are per language.
  await patchSettings(propertyId, {
    facilities: normalizeFacilities(form.getAll("facility").map(String)),
  });
  const lines = String(form.get("extra") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  await saveFacilitiesExtra(propertyId, lang, lines);
  return { ok: true as const };
}

export function meta() {
  return [{ title: "Admin · Facilities" }];
}

export default function AdminFacilities({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const t = useAdminT();
  const adminLang = useAdminLang();
  // Facility labels live in the GUEST dictionary — they're guest-facing copy and
  // it already covers all eight languages, so the admin (en/de/pt) reads the
  // same strings rather than keeping a second, driftable copy.
  const label = makeTranslator(adminLang);

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("facTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("facAddPropertyFirst")}</p>
      </div>
    );
  }

  const { lang, chosen, extra, baseExtra, copyable } = loaderData;
  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{t("facTitle")}</h1>
        {actionData && "ok" in actionData && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            {t("saved")}
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">{t("facIntro")}</p>

      {copyable > 0 && (
        <Form method="post" className="mb-6 flex flex-wrap items-center gap-4 rounded-[14px] border border-line bg-surface-alt px-5 py-4">
          <input type="hidden" name="op" value="copyFromGoogle" />
          <input type="hidden" name="lang" value={lang} />
          <p className="flex-1 text-[13px] text-secondary">{t("facCopyFromGoogleHint", { n: copyable })}</p>
          <button
            type="submit"
            disabled={saving}
            className="flex-none cursor-pointer rounded-[9px] border border-accent px-4 py-2 text-[13px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-60"
          >
            {t("facCopyFromGoogle")}
          </button>
        </Form>
      )}

      {/* Keyed on the SAVED selection, not just the language: the checkboxes are
          uncontrolled, so after "copy from Google" rewrites the set React would
          otherwise reuse the existing DOM nodes and leave them unticked — and
          the next Save would post that empty set straight back over the copy. */}
      <Form
        method="post"
        key={`${lang}:${chosen.join(",")}`}
        className="flex flex-col gap-6 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="op" value="save" />

        <div>
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("facChooseTitle")}</div>
          <p className="mb-4 text-[13px] text-muted">{t("facChooseHint")}</p>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {PROPERTY_FACILITIES.map((key) => (
              <label key={key} className="flex items-center gap-2.5 text-[14px] text-secondary">
                <input
                  type="checkbox"
                  name="facility"
                  value={key}
                  defaultChecked={chosen.includes(key)}
                  className="h-4 w-4 flex-none accent-[var(--accent)]"
                />
                {label.t(facilityLabelKey(key))}
              </label>
            ))}
          </div>
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("facExtraTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("facExtraHint")}</p>
          <textarea
            name="extra"
            rows={5}
            defaultValue={extra.join("\n")}
            placeholder={baseExtra.length ? baseExtra.join("\n") : t("facExtraPlaceholder")}
            className={FIELD_INPUT}
          />
        </div>

        {actionData && "error" in actionData && (
          <p className="text-[13px] text-red-600">{actionData.error}</p>
        )}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? t("saving") : t("saveChanges")}
          </button>
        </div>
      </Form>
    </div>
  );
}
