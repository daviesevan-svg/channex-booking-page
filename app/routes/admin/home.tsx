import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/home";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { DEFAULT_PROMO_PLACEHOLDER, langParam, pickLang, searchDefaults, type SearchContent } from "~/lib/content";
import {
  getHeroImage,
  getSearchContentRaw,
  saveHeroImage,
  saveSearchContent,
} from "~/lib/overrides.server";
import { uploadHomeImage } from "~/lib/images.server";
import { Field, FIELD_INPUT, FilePicker } from "~/components/admin-form";
import { useAdminLang, useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const content = await getSearchContentRaw(propertyId, lang);
  const heroImage = await getHeroImage(propertyId);
  return { configured: true as const, content, heroImage, lang };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };

  const form = await request.formData();
  const s = (v: FormDataEntryValue | null) => String(v ?? "").trim();
  const titles = form.getAll("highlightTitle").map(String);
  const descs = form.getAll("highlightDesc").map(String);
  // Keep only rows the editor actually filled in; empty => fall back to the
  // language defaults rather than baking in English.
  const highlights = [0, 1, 2]
    .map((i) => ({ title: (titles[i] ?? "").trim(), description: (descs[i] ?? "").trim() }))
    .filter((h) => h.title || h.description);

  const content: SearchContent = {
    eyebrow: s(form.get("eyebrow")) || undefined,
    heading: s(form.get("heading")) || undefined,
    intro: s(form.get("intro")) || undefined,
    promoText: s(form.get("promoText")) || undefined,
    promoPlaceholder: s(form.get("promoPlaceholder")) || undefined,
    searchButton: s(form.get("searchButton")) || undefined,
    highlights: highlights.length ? highlights : undefined,
  };
  // saveSearchContent never touches heroImage (saveHeroImage owns it), so a
  // text-only save keeps the previously uploaded image.
  await saveSearchContent(propertyId, pickLang(s(form.get("lang"))), content);

  const upload = form.get("heroUpload");
  const file = upload instanceof File && upload.size > 0 ? upload : null;
  try {
    if (form.get("removeHero")) {
      await saveHeroImage(propertyId, null);
    } else if (file) {
      await saveHeroImage(propertyId, await uploadHomeImage(propertyId, file));
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Image upload failed." };
  }
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Home page" }];
}


export default function AdminHome({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const t = useAdminT();
  // Example placeholders in the admin's language. They're only samples — what
  // guests actually see when a field is empty is searchDefaults(guest lang).
  const d = searchDefaults(useAdminLang());

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Home page</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to edit page
          content.
        </p>
      </div>
    );
  }

  const { content, heroImage, lang } = loaderData;
  const currentHero = heroImage;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{t("homeTitle")}</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            {t("saved")}
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">{t("homeIntro")}</p>

      <Form
        method="post"
        key={lang}
        encType="multipart/form-data"
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <Field name="eyebrow" label={t("homeEyebrow")} value={content.eyebrow} placeholder="Carmarthen" />
        <Field name="heading" label={t("homeHeading")} value={content.heading} placeholder={d.heading} />
        <Field name="intro" label={t("homeIntroField")} value={content.intro} placeholder={d.intro} textarea />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field name="searchButton" label={t("homeSearchButton")} value={content.searchButton} placeholder={d.searchButton} />
          <Field
            name="promoText"
            label={t("homePromoText")}
            value={content.promoText}
            placeholder={d.promoText}
            hint={t("homePromoTextHint")}
          />
          <Field
            name="promoPlaceholder"
            label={t("homePromoPlaceholder")}
            value={content.promoPlaceholder}
            placeholder={DEFAULT_PROMO_PLACEHOLDER}
            hint={t("homePromoPlaceholderHint")}
          />
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-3 font-serif text-[18px] font-semibold">{t("homeHighlights")}</div>
          <div className="flex flex-col gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.6fr]">
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("homeHighlightTitle", { n: i + 1 })}
                  <input
                    name="highlightTitle"
                    defaultValue={content.highlights?.[i]?.title}
                    placeholder={d.highlights[i].title}
                    className={FIELD_INPUT}
                  />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("homeHighlightDesc")}
                  <input
                    name="highlightDesc"
                    defaultValue={content.highlights?.[i]?.description}
                    placeholder={d.highlights[i].description}
                    className={FIELD_INPUT}
                  />
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("homeFeatureImage")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("homeFeatureImageHint")}</p>
          <div className="flex flex-wrap items-start gap-4">
            <div className="h-[120px] w-[200px] flex-none overflow-hidden rounded-[12px] border border-line-alt bg-surface-alt">
              {currentHero ? (
                <img src={currentHero} alt="" className="h-full w-full object-cover" />
              ) : (
                <div
                  className="h-full w-full"
                  style={{
                    background:
                      "repeating-linear-gradient(135deg,#efe7da,#efe7da 13px,#e7ddcc 13px,#e7ddcc 26px)",
                  }}
                />
              )}
            </div>
            <div className="flex min-w-[220px] flex-1 flex-col gap-2.5">
              <FilePicker name="heroUpload" accept="image/*" />
              <p className="text-[12px] text-faint">{t("homeImageFormats")}</p>
              {heroImage && (
                <label className="flex items-center gap-2 text-[13px] text-secondary">
                  <input type="checkbox" name="removeHero" value="1" />
                  {t("homeRemoveImage")}
                </label>
              )}
            </div>
          </div>
        </div>

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
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
