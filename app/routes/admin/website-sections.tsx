import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/website-sections";
import { adminMeta } from "~/lib/admin-meta";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { langParam, pickLang } from "~/lib/content";
import { getSettings } from "~/lib/overrides.server";
import { HOME_PAGE_ID, PAGE_TEXT_FIELDS, pageTextKey, sectionIdFor } from "~/lib/pages";
import {
  addableTypes,
  imageAltKey,
  MAX_SECTION_IMAGES,
  SECTION_DEFS,
  SECTION_TYPES,
  type SectionImage,
  type SectionType,
  type SiteSection,
} from "~/lib/sections";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { uploadSectionImage } from "~/lib/images.server";
import {
  addSectionImages,
  getPageEditor,
  listPages,
  savePageSections,
  saveSiteCopy,
} from "~/lib/site.server";
import { FIELD_INPUT, FilePicker } from "~/components/admin-form";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  // ?page=<id> edits an extra page; no parameter means the home page, which is
  // what this screen has always been.
  const pageId = new URL(request.url).searchParams.get("page") || HOME_PAGE_ID;
  const [editor, settings, pages] = await Promise.all([
    getPageEditor(propertyId, pageId, lang),
    getSettings(propertyId),
    listPages(propertyId, lang),
  ]);
  // A deleted page's bookmark must not silently edit the home page instead.
  if (!editor) throw new Response("Page not found", { status: 404 });

  return {
    configured: true as const,
    lang,
    pageId,
    isHome: editor.isHome,
    pageTitle: pages.find((p) => p.id === pageId)?.title ?? "",
    sections: editor.page.sections,
    text: editor.text,
    baseText: editor.baseText,
    websiteEnabled: settings.websiteEnabled ?? false,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };

  const form = await request.formData();
  const lang = pickLang(String(form.get("lang") ?? ""));
  const pageId = String(form.get("pageId") ?? "") || HOME_PAGE_ID;

  // Order and identity travel together in one field per section, so the
  // ordering can't drift out of step with a parallel list of types.
  const sections: SiteSection[] = [];
  for (const raw of form.getAll("section").map(String)) {
    const [id, type] = raw.split("|");
    if (!id || !SECTION_TYPES.includes(type as SectionType)) continue;
    const t = type as SectionType;
    const settings: Record<string, string | number | boolean> = {};
    for (const f of SECTION_DEFS[t].fields) {
      if (f.localized) continue;
      const v = form.get(`s:${id}:${f.key}`);
      if (f.kind === "boolean") {
        settings[f.key] = v === "on";
      } else if (f.kind === "number") {
        // Leave it unset when the field wasn't submitted or was cleared, so the
        // default applies. `Number(null)` is 0, which would silently store a
        // "show 0 of these" that the guest renderer then has to clamp away.
        if (v === null || String(v).trim() === "") continue;
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        const min = f.min ?? 1;
        const max = f.max ?? Number.MAX_SAFE_INTEGER;
        settings[f.key] = Math.min(max, Math.max(min, Math.round(n)));
      } else if (v !== null) {
        // A select only ever stores one of its declared options.
        const s = String(v);
        if (!f.options || f.options.includes(s)) settings[f.key] = s;
      }
    }
    // Images travel with the structure, in the order the hidden fields appear —
    // so removing or moving one is just a save, exactly like a section.
    const images: SectionImage[] = form
      .getAll(`i:${id}`)
      .map(String)
      .map((raw) => {
        const at = raw.indexOf("|");
        return at < 0 ? null : { id: raw.slice(0, at), url: raw.slice(at + 1) };
      })
      .filter((x): x is SectionImage => Boolean(x?.id && x.url));

    sections.push({ id, type: t, hidden: form.get(`h:${id}`) === "on", settings, images });
  }
  // Removing a picture is this save, so the dropped urls come back from it.
  queueImageCleanup(propertyId, await savePageSections(propertyId, pageId, sections));

  // Save copy AFTER the structure, so saveSiteCopy prunes against the layout
  // that was just written rather than the one it replaced.
  const text: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("t:")) continue;
    const [, id, field] = k.split(":");
    if (id && field) text[`${id}.${field}`] = String(v);
  }
  await saveSiteCopy(propertyId, lang, pageId, text);

  // An upload comes from a button inside this same form, so everything above has
  // just been persisted and nothing typed is lost — which is why the new files
  // are appended after the save rather than instead of it.
  const uploadFor = String(form.get("uploadFor") ?? "");
  if (uploadFor) {
    const files = form
      .getAll(`file:${uploadFor}`)
      .filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) return { error: "Choose an image first." };
    try {
      const urls: string[] = [];
      for (const file of files) urls.push(await uploadSectionImage(propertyId, file));
      // One batch, one write — addSectionImages is read-modify-write.
      const { skipped } = await addSectionImages(propertyId, pageId, uploadFor, urls);
      if (skipped) {
        return { error: `Only ${MAX_SECTION_IMAGES} images per section — ${skipped} not added.` };
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Image upload failed." };
    }
  }
  return { ok: true as const };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "secTitle" });
}

export default function AdminWebsiteSections({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const t = useAdminT();

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("secTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("secAddPropertyFirst")}</p>
      </div>
    );
  }

  const { lang, pageId, isHome, pageTitle, sections, text, baseText, websiteEnabled } = loaderData;
  const error = (actionData && "error" in actionData ? actionData.error : null) ?? null;
  return (
    <Editor
      // Remount on a saved change (or a switch to another page) so the
      // uncontrolled inputs pick up the new order and any pruned copy, rather
      // than keeping stale DOM state. Image ids are part of this: an upload
      // changes nothing else, so without them a new photo wouldn't appear until
      // the editor was reloaded by hand.
      key={`${pageId}:${lang}:${sections
        .map((s) => [s.id, ...(s.images ?? []).map((i) => i.id)].join("~"))
        .join(",")}`}
      lang={lang}
      pageId={pageId}
      isHome={isHome}
      pageTitle={pageTitle}
      initial={sections}
      text={text}
      baseText={baseText}
      websiteEnabled={websiteEnabled}
      saving={saving}
      saved={Boolean(actionData && "ok" in actionData)}
      error={error}
      t={t}
    />
  );
}

function Editor({
  lang,
  pageId,
  isHome,
  pageTitle,
  initial,
  text,
  baseText,
  websiteEnabled,
  saving,
  saved,
  error,
  t,
}: {
  lang: string;
  pageId: string;
  isHome: boolean;
  pageTitle: string;
  initial: SiteSection[];
  text: Record<string, string>;
  baseText: Record<string, string>;
  websiteEnabled: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  t: ReturnType<typeof useAdminT>;
}) {
  const [list, setList] = useState(initial);
  const [adding, setAdding] = useState<SectionType | "">("");

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
  };
  const remove = (id: string) => setList(list.filter((s) => s.id !== id));

  /** Images live on the section, so dropping or moving one is local state that
   *  the next save persists — no separate request, and no half-applied delete. */
  const patchImages = (sectionId: string, fn: (imgs: SectionImage[]) => SectionImage[]) =>
    setList((prev) =>
      prev.map((s) => (s.id === sectionId ? { ...s, images: fn(s.images ?? []) } : s)),
    );
  const add = () => {
    if (!adding) return;
    // Built-ins keep their type in the id so copy written before a removal comes
    // back with it; the id also carries the page, because the copy map is shared
    // and an About heading must not land on the home page's.
    const id = sectionIdFor(
      adding,
      pageId,
      list.map((s) => s.id),
    );
    setList([...list, { id, type: adding, hidden: false, settings: {} }]);
    setAdding("");
  };

  const canAdd = addableTypes(list, isHome);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">
          {isHome ? t("secTitle") : pageTitle || t("wpUntitled")}
        </h1>
        {saved && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            {t("saved")}
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">{isHome ? t("secIntro") : t("wpSectionsIntro")}</p>

      {!isHome && (
        <p className="mb-5 text-[13px]">
          <Link to="/admin/website/pages" className="font-semibold text-accent hover:underline">
            ← {t("navPages")}
          </Link>
        </p>
      )}

      {!websiteEnabled && (
        <p className="mb-5 rounded-[10px] border border-[#e6dcc4] bg-[#fbf6ea] px-4 py-3 text-[12.5px] leading-[1.55] text-[#7a6636]">
          {t("secWebsiteOff")}{" "}
          <Link to="/admin/website" className="font-semibold underline">
            {t("navWebsiteGeneral")}
          </Link>
        </p>
      )}

      {error && (
        <p className="mb-5 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] font-medium text-red-700">
          {error}
        </p>
      )}

      {/* multipart because the text-block sections upload their own pictures.
          Every other field is unaffected — the action reads them the same way. */}
      <Form method="post" encType="multipart/form-data" className="flex flex-col gap-4">
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="pageId" value={pageId} />

        {/* The page's own name and search-result description. Per language, so
            they live here beside the rest of the translated copy rather than on
            the Pages screen, which has no language tabs. */}
        {!isHome && (
          <div className="rounded-[14px] border border-line bg-surface p-5">
            <div className="mb-3 font-serif text-[18px] font-semibold">{t("wpPageDetails")}</div>
            <div className="flex flex-col gap-3">
              {PAGE_TEXT_FIELDS.map((field) => {
                const tKey = pageTextKey(pageId, field);
                const common = {
                  name: `t:page_${pageId}:${field}`,
                  defaultValue: text[tKey] ?? "",
                  placeholder: baseText[tKey] ?? "",
                  className: FIELD_INPUT,
                };
                return (
                  <label key={field} className="block text-[13px] font-semibold text-secondary">
                    {t(`wpField_${field}`)}
                    {field === "metaDescription" ? (
                      <textarea rows={2} maxLength={200} {...common} />
                    ) : (
                      <input maxLength={80} {...common} />
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {list.map((section, i) => {
          const def = SECTION_DEFS[section.type];
          return (
            <div
              key={section.id}
              className={`rounded-[14px] border bg-surface p-5 ${section.hidden ? "border-dashed border-line-alt opacity-70" : "border-line"}`}
            >
              <input type="hidden" name="section" value={`${section.id}|${section.type}`} />
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="font-serif text-[18px] font-semibold">
                  {t(def.labelKey)}
                  {def.required && (
                    <span className="ml-2 rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      {t("secRequired")}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[12.5px] text-secondary">
                    <input
                      type="checkbox"
                      name={`h:${section.id}`}
                      defaultChecked={section.hidden}
                      disabled={def.required}
                    />
                    {t("secHide")}
                  </label>
                  <Move onClick={() => move(i, -1)} disabled={i === 0} label="↑" title={t("secMoveUp")} />
                  <Move
                    onClick={() => move(i, 1)}
                    disabled={i === list.length - 1}
                    label="↓"
                    title={t("secMoveDown")}
                  />
                  {!def.required && (
                    <button
                      type="button"
                      onClick={() => remove(section.id)}
                      className="cursor-pointer rounded-[8px] border border-line px-3 py-1.5 text-[12.5px] font-semibold text-red-600 hover:bg-red-50"
                    >
                      {t("secRemove")}
                    </button>
                  )}
                </div>
              </div>

              {def.fields.length === 0 ? (
                <p className="text-[12.5px] text-muted">
                  {t("secEditedElsewhere")}{" "}
                  <Link to="/admin/home" className="font-semibold text-accent hover:underline">
                    {t("navHome")}
                  </Link>
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {def.fields.map((f) => {
                    const tKey = `${section.id}.${f.key}`;
                    const label = t(`secField_${f.key}`);
                    // Only one of these two ever applies, so only one is shown:
                    // which side the photos go on is meaningless without photos,
                    // and centring the copy is meaningless beside them.
                    const hasImages = Boolean(section.images?.length);
                    if (f.key === "imageSide" && !hasImages) return null;
                    if (f.key === "align" && hasImages) return null;
                    if (f.localized) {
                      const common = {
                        name: `t:${section.id}:${f.key}`,
                        defaultValue: text[tKey] ?? "",
                        placeholder: baseText[tKey] ?? placeholderFor(section.type, f.key, t),
                        className: FIELD_INPUT,
                      };
                      return (
                        <label key={f.key} className="block text-[13px] font-semibold text-secondary">
                          {label}
                          {f.kind === "textarea" ? (
                            <textarea rows={f.rich ? 5 : 3} {...common} />
                          ) : (
                            <input {...common} />
                          )}
                          {/* Nobody guesses that asterisks do anything, so the
                              syntax is spelled out next to the box that takes it. */}
                          {f.rich && (
                            <span className="mt-1 block text-[11.5px] font-normal leading-[1.5] text-muted-2">
                              {t("secRichHint")}
                            </span>
                          )}
                        </label>
                      );
                    }
                    if (f.kind === "number") {
                      return (
                        <label key={f.key} className="block text-[13px] font-semibold text-secondary">
                          {label}
                          <input
                            type="number"
                            name={`s:${section.id}:${f.key}`}
                            min={f.min}
                            max={f.max}
                            defaultValue={Number(section.settings?.[f.key] ?? f.default ?? 1)}
                            className={`${FIELD_INPUT} max-w-[140px]`}
                          />
                        </label>
                      );
                    }
                    if (f.kind === "boolean") {
                      return (
                        <label key={f.key} className="flex items-center gap-2 text-[13px] text-secondary">
                          <input
                            type="checkbox"
                            name={`s:${section.id}:${f.key}`}
                            defaultChecked={Boolean(section.settings?.[f.key] ?? f.default)}
                          />
                          {label}
                        </label>
                      );
                    }
                    return (
                      <label key={f.key} className="block text-[13px] font-semibold text-secondary">
                        {label}
                        <select
                          name={`s:${section.id}:${f.key}`}
                          defaultValue={String(section.settings?.[f.key] ?? f.default ?? "")}
                          className={`${FIELD_INPUT} max-w-[220px]`}
                        >
                          {(f.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {t(`secOpt_${o}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}

              {def.images && (
                <SectionImages
                  section={section}
                  text={text}
                  baseText={baseText}
                  saving={saving}
                  t={t}
                  onMove={(from, to) =>
                    patchImages(section.id, (imgs) => {
                      if (to < 0 || to >= imgs.length) return imgs;
                      const next = [...imgs];
                      [next[from], next[to]] = [next[to], next[from]];
                      return next;
                    })
                  }
                  onRemove={(imageId) =>
                    patchImages(section.id, (imgs) => imgs.filter((x) => x.id !== imageId))
                  }
                />
              )}
            </div>
          );
        })}

        {canAdd.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-dashed border-line-alt bg-surface-alt p-5">
            <span className="text-[13px] font-semibold text-secondary">{t("secAdd")}</span>
            <select
              value={adding}
              onChange={(e) => setAdding(e.target.value as SectionType)}
              className={`${FIELD_INPUT} !mt-0 max-w-[240px]`}
            >
              <option value="">{t("secAddChoose")}</option>
              {canAdd.map((type) => (
                <option key={type} value={type}>
                  {t(SECTION_DEFS[type].labelKey)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={add}
              disabled={!adding}
              className="cursor-pointer rounded-[9px] border border-accent px-4 py-2 text-[13px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-50"
            >
              {t("secAddButton")}
            </button>
          </div>
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

/**
 * One text block's picture column: upload, reorder, remove, and alt text per
 * language.
 *
 * The images are submitted as hidden fields in display order, so they're part of
 * the ordinary section save — reordering and removing need no request of their
 * own, and can't leave a photo half-deleted. Only the upload needs the server,
 * and it submits this whole form, so nothing typed is lost when you click it.
 */
function SectionImages({
  section,
  text,
  baseText,
  saving,
  t,
  onMove,
  onRemove,
}: {
  section: SiteSection;
  text: Record<string, string>;
  baseText: Record<string, string>;
  saving: boolean;
  t: ReturnType<typeof useAdminT>;
  onMove: (from: number, to: number) => void;
  onRemove: (imageId: string) => void;
}) {
  const images = section.images ?? [];
  const full = images.length >= MAX_SECTION_IMAGES;

  return (
    <div className="mt-4 border-t border-line-alt pt-4">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-secondary">{t("secImages")}</span>
        <span className="text-[12px] text-muted-2">
          {t("secImagesHint", { n: MAX_SECTION_IMAGES })}
        </span>
      </div>

      {images.length > 0 && (
        <div className="mb-3 flex flex-col gap-2.5">
          {images.map((img, n) => {
            const key = `${section.id}.${imageAltKey(img.id)}`;
            return (
              <div
                key={img.id}
                className="flex items-center gap-3 rounded-[10px] border border-line bg-surface-alt p-2.5"
              >
                <input type="hidden" name={`i:${section.id}`} value={`${img.id}|${img.url}`} />
                <img
                  src={img.url}
                  alt=""
                  className="h-14 w-20 flex-none rounded-[6px] border border-line object-cover"
                />
                <label className="min-w-0 flex-1 text-[12px] font-semibold text-muted-2">
                  {t("secField_imageAlt")}
                  <input
                    name={`t:${section.id}:${imageAltKey(img.id)}`}
                    defaultValue={text[key] ?? ""}
                    placeholder={baseText[key] ?? t("secImageAltPlaceholder")}
                    maxLength={200}
                    className={`${FIELD_INPUT} !mt-1`}
                  />
                </label>
                <div className="flex flex-none items-center gap-1.5">
                  <Move
                    onClick={() => onMove(n, n - 1)}
                    disabled={n === 0}
                    label="↑"
                    title={t("secMoveUp")}
                  />
                  <Move
                    onClick={() => onMove(n, n + 1)}
                    disabled={n === images.length - 1}
                    label="↓"
                    title={t("secMoveDown")}
                  />
                  <button
                    type="button"
                    onClick={() => onRemove(img.id)}
                    title={t("secRemove")}
                    aria-label={t("secRemove")}
                    className="cursor-pointer rounded-[8px] border border-line px-3 py-1.5 text-[13px] font-semibold text-red-600 hover:bg-red-50"
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {full ? (
        <p className="text-[12px] text-muted-2">{t("secImagesFull", { n: MAX_SECTION_IMAGES })}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <FilePicker name={`file:${section.id}`} accept="image/*" multiple />
          {/* `uploadFor` tells the action which section the files belong to, and
              only the clicked button carries it — every other section's picker
              stays inert. */}
          <button
            type="submit"
            name="uploadFor"
            value={section.id}
            disabled={saving}
            className="cursor-pointer rounded-[9px] border border-accent px-4 py-2 text-[13px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-50"
          >
            {saving ? t("saving") : t("secImagesUpload")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The guest-facing default a blank heading falls back to, shown as the hint. */
function placeholderFor(type: SectionType, key: string, t: ReturnType<typeof useAdminT>): string {
  if (key !== "heading") return "";
  const headingKey = SECTION_DEFS[type].headingKey;
  return headingKey ? t(`secDefault_${type}`) : "";
}

function Move({
  onClick,
  disabled,
  label,
  title,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="cursor-pointer rounded-[8px] border border-line px-3 py-1.5 text-[13px] font-semibold text-secondary hover:bg-chip disabled:cursor-default disabled:opacity-35"
    >
      {label}
    </button>
  );
}
