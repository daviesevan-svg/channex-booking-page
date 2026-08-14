import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/home";
import { adminMeta } from "~/lib/admin-meta";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { DEFAULT_LANG, DEFAULT_PROMO_PLACEHOLDER, langParam, pickLang, searchDefaults, type SearchContent } from "~/lib/content";
import {
  getHeroImage,
  getOverrides,
  getSearchContentRaw,
  saveHeroImage,
  saveSearchContent,
} from "~/lib/overrides.server";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { resolveImageField, uploadHomeImage } from "~/lib/images.server";
import { Field, FIELD_INPUT, FilePicker, TranslationNote } from "~/components/admin-form";
import { AdminPageHeader } from "~/components/admin-page-header";
import { useAdminLang, useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const content = await getSearchContentRaw(propertyId, lang);
  const heroImage = await getHeroImage(propertyId);
  // The eyebrow's default IS the property name (property/search.tsx), so the
  // field's placeholder shows it — same "what guests see when this is blank"
  // contract as every other placeholder on this form.
  const { hotelName } = await getOverrides(propertyId, lang);
  return { configured: true as const, content, heroImage, hotelName, lang };
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

  // Replacing or clearing the hero orphans the file that was there.
  const previousHero = await getHeroImage(propertyId);
  const hero = await resolveImageField(form, {
    fileKey: "heroUpload",
    removeKey: "removeHero",
    previous: previousHero ?? undefined,
    upload: (f) => uploadHomeImage(propertyId, f),
  });
  if (!hero.ok) return { error: hero.error };
  await saveHeroImage(propertyId, hero.url ?? null);
  if (previousHero && previousHero !== (await getHeroImage(propertyId))) {
    queueImageCleanup(propertyId, [previousHero]);
  }
  return { ok: true };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navHome" });
}


export default function AdminHome({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const t = useAdminT();
  const adminLang = useAdminLang();

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

  const { content, heroImage, hotelName, lang } = loaderData;
  const currentHero = heroImage;
  // Content placeholders ("what guests see when this is blank") only make
  // sense on the default-language tab. On a translation tab they showed the
  // default text inside every empty field, which read as untranslated content
  // (TranslationNote) — there the fields stay visibly empty.
  const isBase = lang === DEFAULT_LANG;
  const d = searchDefaults(adminLang);

  return (
    <div>
      <AdminPageHeader title={t("homeTitle")} saved={Boolean(actionData?.ok)} />
      {isBase ? (
        <p className="mb-6 text-[14px] text-muted">{t("homeIntro")}</p>
      ) : (
        <TranslationNote lang={lang} />
      )}

      <Form
        method="post"
        key={lang}
        encType="multipart/form-data"
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <Field
          name="eyebrow"
          label={t("homeEyebrow")}
          value={content.eyebrow}
          placeholder={isBase ? hotelName || t("homeEyebrowPlaceholder") : undefined}
          hint={t("homeEyebrowHint")}
        />
        <Field
          name="heading"
          label={t("homeHeading")}
          value={content.heading}
          placeholder={isBase ? d.heading : undefined}
          hint={t("homeHeadingHint")}
        />
        <Field
          name="intro"
          label={t("homeIntroField")}
          value={content.intro}
          placeholder={isBase ? d.intro : undefined}
          hint={t("homeIntroFieldHint")}
          textarea
        />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field
            name="searchButton"
            label={t("homeSearchButton")}
            value={content.searchButton}
            placeholder={isBase ? d.searchButton : undefined}
            hint={t("homeSearchButtonHint")}
          />
          <Field
            name="promoText"
            label={t("homePromoText")}
            value={content.promoText}
            placeholder={isBase ? d.promoText : undefined}
            hint={t("homePromoTextHint")}
          />
          <Field
            name="promoPlaceholder"
            label={t("homePromoPlaceholder")}
            value={content.promoPlaceholder}
            placeholder={isBase ? DEFAULT_PROMO_PLACEHOLDER : undefined}
            hint={t("homePromoPlaceholderHint")}
          />
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("homeHighlights")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("homeHighlightsHint")}</p>
          <div className="flex flex-col gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.6fr]">
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("homeHighlightTitle", { n: i + 1 })}
                  <input
                    name="highlightTitle"
                    defaultValue={content.highlights?.[i]?.title}
                    placeholder={isBase ? d.highlights[i].title : undefined}
                    className={FIELD_INPUT}
                  />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("homeHighlightDesc")}
                  <input
                    name="highlightDesc"
                    defaultValue={content.highlights?.[i]?.description}
                    placeholder={isBase ? d.highlights[i].description : undefined}
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
