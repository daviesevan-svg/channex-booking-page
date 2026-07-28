import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/website-sections";
import { adminMeta } from "~/lib/page-meta";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { langParam, pickLang } from "~/lib/content";
import { getSettings } from "~/lib/overrides.server";
import { HOME_PAGE_ID, PAGE_TEXT_FIELDS, pageTextKey, sectionIdFor } from "~/lib/pages";
import {
  addableTypes,
  SECTION_DEFS,
  SECTION_TYPES,
  type SectionType,
  type SiteSection,
} from "~/lib/sections";
import { getPageEditor, listPages, savePageSections, saveSiteCopy } from "~/lib/site.server";
import { FIELD_INPUT } from "~/components/admin-form";
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
    sections.push({ id, type: t, hidden: form.get(`h:${id}`) === "on", settings });
  }
  await savePageSections(propertyId, pageId, sections);

  // Save copy AFTER the structure, so saveSiteCopy prunes against the layout
  // that was just written rather than the one it replaced.
  const text: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("t:")) continue;
    const [, id, field] = k.split(":");
    if (id && field) text[`${id}.${field}`] = String(v);
  }
  await saveSiteCopy(propertyId, lang, pageId, text);
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
  return (
    <Editor
      // Remount on a saved change (or a switch to another page) so the
      // uncontrolled inputs pick up the new order and any pruned copy, rather
      // than keeping stale DOM state.
      key={`${pageId}:${lang}:${sections.map((s) => s.id).join(",")}`}
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

      <Form method="post" className="flex flex-col gap-4">
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
                            <textarea rows={3} {...common} />
                          ) : (
                            <input {...common} />
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
