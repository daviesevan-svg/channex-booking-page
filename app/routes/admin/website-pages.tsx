// Website → Pages: the extra pages beyond home.
//
// This page owns what a page IS — its address, whether it's in the menu, and
// whether it exists. What a page CONTAINS is the section editor, which is where
// the language tabs are: a page's title and description are per-language, so
// they belong beside the other translated copy rather than here.

import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/website-pages";
import { adminMeta } from "~/lib/admin-meta";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getProperty } from "~/lib/properties.server";
import { langParam } from "~/lib/content";
import { getSettings } from "~/lib/overrides.server";
import { MAX_PAGES, slugifyPage } from "~/lib/pages";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { createPage, deletePage, listPages, updatePage } from "~/lib/site.server";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const [pages, settings, ref] = await Promise.all([
    listPages(propertyId, lang),
    getSettings(propertyId),
    getProperty(propertyId),
  ]);
  return {
    configured: true as const,
    // Extra pages only — home has no address to change and can't be deleted, so
    // there's nothing for it to do on this screen.
    pages: pages.filter((p) => !p.isHome),
    websiteEnabled: settings.websiteEnabled ?? false,
    // The pretty segment, so "View" opens the page a guest would see.
    linkId: ref?.slug || propertyId,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");

  if (intent === "create") {
    const title = String(form.get("title") ?? "");
    // An empty address is derived from the title, so a hotel can type "Our
    // story" and get /our-story without thinking about URLs.
    const raw = String(form.get("slug") ?? "").trim();
    const result = await createPage(propertyId, raw || slugifyPage(title), title);
    return "error" in result ? { error: result.error } : { ok: true as const };
  }
  if (intent === "save" && id) {
    const result = await updatePage(propertyId, id, {
      slug: String(form.get("slug") ?? ""),
      nav: form.get("nav") === "on",
    });
    return "error" in result ? { error: result.error } : { ok: true as const };
  }
  if (intent === "delete" && id) {
    // The deleted page was the only thing referencing its section pictures.
    queueImageCleanup(propertyId, await deletePage(propertyId, id));
    return { ok: true as const };
  }
  return { error: "Unknown action." };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "wpTitle" });
}

export default function AdminWebsitePages({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("wpTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("secAddPropertyFirst")}</p>
      </div>
    );
  }

  const { pages, websiteEnabled, linkId } = loaderData;
  const error = actionData && "error" in actionData ? actionData.error : null;
  const saved = Boolean(actionData && "ok" in actionData);
  const atLimit = pages.length >= MAX_PAGES;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{t("wpTitle")}</h1>
        {saved && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            {t("saved")}
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">{t("wpIntro")}</p>

      {!websiteEnabled && (
        <p className="mb-5 rounded-[10px] border border-[#e6dcc4] bg-[#fbf6ea] px-4 py-3 text-[12px] leading-[1.55] text-[#7a6636]">
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

      <div className="flex flex-col gap-4">
        {pages.map((page) => (
          <Form
            // Remount when the saved slug changes so the uncontrolled input shows
            // what was stored, not what was typed and rejected.
            key={`${page.id}:${page.slug}`}
            method="post"
            className="rounded-[14px] border border-line bg-surface p-5"
          >
            <input type="hidden" name="id" value={page.id} />
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="font-serif text-[18px] font-semibold">
                {page.title || t("wpUntitled")}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to={`/admin/website/sections?page=${page.id}`}
                  className="rounded-[8px] border border-line px-3 py-1.5 text-[12px] font-semibold text-secondary hover:bg-chip"
                >
                  {t("wpEditContent")}
                </Link>
                <a
                  href={`/${linkId}/${page.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-[8px] border border-line px-3 py-1.5 text-[12px] font-semibold text-secondary hover:bg-chip"
                >
                  {t("wpView")} ↗
                </a>
                <button
                  type="submit"
                  name="intent"
                  value="delete"
                  disabled={busy}
                  // The page and all its text in every language go together —
                  // worth a confirm, since nothing else here is destructive.
                  onClick={(e) => {
                    if (!confirm(t("wpConfirmDelete"))) e.preventDefault();
                  }}
                  className="cursor-pointer rounded-[8px] border border-line px-3 py-1.5 text-[12px] font-semibold text-red-600 hover:bg-red-50"
                >
                  {t("secRemove")}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-5">
              <label className="block text-[13px] font-semibold text-secondary">
                {t("wpAddress")}
                <span className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-[13px] text-muted-2">/{linkId}/</span>
                  <input
                    name="slug"
                    defaultValue={page.slug}
                    maxLength={48}
                    className={`${FIELD_INPUT} !mt-0 max-w-[220px]`}
                  />
                </span>
              </label>
              <label className="flex items-center gap-2 pb-2.5 text-[13px] text-secondary">
                <input type="checkbox" name="nav" defaultChecked={page.nav} />
                {t("wpInMenu")}
              </label>
              <button
                type="submit"
                name="intent"
                value="save"
                disabled={busy}
                className="mb-1 cursor-pointer rounded-[9px] border border-accent px-4 py-2 text-[13px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-50"
              >
                {t("saveChanges")}
              </button>
            </div>
            <p className="mt-2 text-[12px] text-muted-2">
              {t("wpSections", { n: page.sectionCount })}
            </p>
          </Form>
        ))}

        {pages.length === 0 && (
          <p className="rounded-[14px] border border-dashed border-line-alt bg-surface-alt p-5 text-[13px] text-muted">
            {t("wpNone")}
          </p>
        )}

        {atLimit ? (
          <p className="text-[12px] text-muted-2">{t("wpLimit", { n: MAX_PAGES })}</p>
        ) : (
          <Form
            method="post"
            className="rounded-[14px] border border-dashed border-line-alt bg-surface-alt p-5"
          >
            <input type="hidden" name="intent" value="create" />
            <div className="mb-3 font-serif text-[16px] font-semibold">{t("wpAdd")}</div>
            <div className="flex flex-wrap items-end gap-5">
              <label className="block text-[13px] font-semibold text-secondary">
                {t("wpPageTitle")}
                <input
                  name="title"
                  required
                  maxLength={80}
                  placeholder={t("wpTitlePlaceholder")}
                  className={`${FIELD_INPUT} max-w-[260px]`}
                />
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                {t("wpAddress")}
                <span className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-[13px] text-muted-2">/{linkId}/</span>
                  <input
                    name="slug"
                    maxLength={48}
                    placeholder={t("wpAddressPlaceholder")}
                    className={`${FIELD_INPUT} !mt-0 max-w-[200px]`}
                  />
                </span>
              </label>
              <button
                type="submit"
                disabled={busy}
                className="mb-1 cursor-pointer rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
              >
                {busy ? t("saving") : t("wpAddButton")}
              </button>
            </div>
            <p className="mt-2.5 text-[12px] text-muted-2">{t("wpAddressHint")}</p>
          </Form>
        )}
      </div>
    </div>
  );
}
