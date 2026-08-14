import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/website-footer";
import { adminMeta } from "~/lib/admin-meta";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { langParam, pickLang } from "~/lib/content";
import { getSettings } from "~/lib/overrides.server";
import {
  footerBlurbKey,
  footerLinkKey,
  httpUrl,
  MAX_FOOTER_LINKS,
  SOCIAL_LABEL,
  SOCIAL_PLATFORMS,
  type FooterLink,
  type SiteFooter,
  type SocialPlatform,
} from "~/lib/footer";
import { getFooterRaw, saveFooter } from "~/lib/site.server";
import { FIELD_INPUT, TranslationNote } from "~/components/admin-form";
import { AdminPageHeader } from "~/components/admin-page-header";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const [{ footer, text }, settings] = await Promise.all([
    getFooterRaw(propertyId, lang),
    getSettings(propertyId),
  ]);
  return {
    configured: true as const,
    lang,
    footer,
    text,
    websiteEnabled: settings.websiteEnabled ?? false,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };

  const form = await request.formData();
  const lang = pickLang(String(form.get("lang") ?? ""));

  const social: Partial<Record<SocialPlatform, string>> = {};
  const rejected: string[] = [];
  for (const p of SOCIAL_PLATFORMS) {
    const raw = String(form.get(`social:${p}`) ?? "").trim();
    if (!raw) continue;
    const url = httpUrl(raw);
    if (url) social[p] = url;
    else rejected.push(SOCIAL_LABEL[p]);
  }

  const links: FooterLink[] = [];
  const text: Record<string, string> = { [footerBlurbKey()]: String(form.get("blurb") ?? "") };
  for (const id of form.getAll("linkId").map(String)) {
    const raw = String(form.get(`linkUrl:${id}`) ?? "").trim();
    const label = String(form.get(`linkLabel:${id}`) ?? "").trim();
    if (!raw && !label) continue; // an empty row is a row the editor didn't fill
    const url = httpUrl(raw);
    if (!url) {
      rejected.push(label || raw);
      continue;
    }
    links.push({ id, url });
    text[footerLinkKey(id)] = label;
  }

  await saveFooter(
    propertyId,
    lang,
    { showContact: form.get("showContact") === "on", social, links },
    text,
  );
  // Save what was valid, then say plainly what didn't stick — silently dropping
  // a URL someone typed is how you get a bug report about "it didn't save".
  return rejected.length
    ? { ok: true as const, warn: `Not saved (needs a full http:// or https:// address): ${rejected.join(", ")}` }
    : { ok: true as const };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "ftTitle" });
}

export default function AdminWebsiteFooter({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const t = useAdminT();

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("ftTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("ftAddPropertyFirst")}</p>
      </div>
    );
  }

  const { lang, footer, text, websiteEnabled } = loaderData;
  return (
    <Editor
      key={`${lang}:${(footer.links ?? []).map((l) => l.id).join(",")}`}
      lang={lang}
      footer={footer}
      text={text}
      websiteEnabled={websiteEnabled}
      saving={saving}
      saved={Boolean(actionData && "ok" in actionData)}
      warn={actionData && "warn" in actionData ? actionData.warn : undefined}
      error={actionData && "error" in actionData ? actionData.error : undefined}
      t={t}
    />
  );
}

function Editor({
  lang,
  footer,
  text,
  websiteEnabled,
  saving,
  saved,
  warn,
  error,
  t,
}: {
  lang: string;
  footer: SiteFooter;
  text: Record<string, string>;
  websiteEnabled: boolean;
  saving: boolean;
  saved: boolean;
  warn?: string;
  error?: string;
  t: ReturnType<typeof useAdminT>;
}) {
  const [links, setLinks] = useState<FooterLink[]>(footer.links ?? []);

  const addLink = () => {
    if (links.length >= MAX_FOOTER_LINKS) return;
    setLinks([...links, { id: crypto.randomUUID(), url: "" }]);
  };
  const removeLink = (id: string) => setLinks(links.filter((l) => l.id !== id));

  return (
    <div>
      <AdminPageHeader title={t("ftTitle")} saved={Boolean(saved)} />
      <p className="mb-6 text-[14px] text-muted">{t("ftIntro")}</p>
      <TranslationNote lang={lang} />

      {!websiteEnabled && (
        <p className="mb-5 rounded-[10px] border border-[#e6dcc4] bg-[#fbf6ea] px-4 py-3 text-[12px] leading-[1.55] text-[#7a6636]">
          {t("ftWebsiteOff")}{" "}
          <Link to="/admin/website" className="font-semibold underline">
            {t("navWebsiteGeneral")}
          </Link>
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error}
        </p>
      )}
      {warn && (
        <p className="mb-4 rounded-[10px] border border-[#e6dcc4] bg-[#fbf6ea] px-4 py-3 text-[13px] text-[#7a6636]">
          {warn}
        </p>
      )}

      <Form method="post" className="flex flex-col gap-6 rounded-[14px] border border-line bg-surface p-6">
        <input type="hidden" name="lang" value={lang} />

        {/* --- blurb --- */}
        <div>
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("ftBlurbTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("ftBlurbHint")}</p>
          <textarea
            name="blurb"
            rows={3}
            defaultValue={text[footerBlurbKey()] ?? ""}
            placeholder={t("ftBlurbPlaceholder")}
            className={FIELD_INPUT}
          />
        </div>

        {/* --- contact --- */}
        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("ftContactTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("ftContactHint")}</p>
          <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3">
            <input
              type="checkbox"
              name="showContact"
              defaultChecked={footer.showContact !== false}
              className="mt-1"
            />
            <span>
              <span className="block text-[14px] font-semibold text-ink">{t("ftShowContact")}</span>
              <span className="block text-[12px] text-muted">{t("ftShowContactDesc")}</span>
            </span>
          </label>
        </div>

        {/* --- social --- */}
        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("ftSocialTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("ftSocialHint")}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {SOCIAL_PLATFORMS.map((p) => (
              <label key={p} className="block text-[13px] font-semibold text-secondary">
                {SOCIAL_LABEL[p]}
                <input
                  name={`social:${p}`}
                  defaultValue={footer.social?.[p] ?? ""}
                  placeholder={`https://…`}
                  autoComplete="off"
                  spellCheck={false}
                  className={FIELD_INPUT}
                />
              </label>
            ))}
          </div>
        </div>

        {/* --- extra links --- */}
        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("ftLinksTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("ftLinksHint", { max: MAX_FOOTER_LINKS })}</p>
          {links.length === 0 ? (
            <p className="mb-3 text-[13px] text-faint">{t("ftLinksEmpty")}</p>
          ) : (
            <div className="mb-3 flex flex-col gap-3">
              {links.map((l) => (
                <div key={l.id} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="linkId" value={l.id} />
                  <label className="min-w-[160px] flex-1 text-[13px] font-semibold text-secondary">
                    {t("ftLinkLabel")}
                    <input
                      name={`linkLabel:${l.id}`}
                      defaultValue={text[footerLinkKey(l.id)] ?? ""}
                      className={FIELD_INPUT}
                    />
                  </label>
                  <label className="min-w-[200px] flex-[1.4] text-[13px] font-semibold text-secondary">
                    {t("ftLinkUrl")}
                    <input
                      name={`linkUrl:${l.id}`}
                      defaultValue={l.url}
                      placeholder="https://…"
                      autoComplete="off"
                      spellCheck={false}
                      className={FIELD_INPUT}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeLink(l.id)}
                    className="cursor-pointer rounded-[8px] border border-line px-3 py-2.5 text-[12px] font-semibold text-red-600 hover:bg-red-50"
                  >
                    {t("ftRemoveLink")}
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={addLink}
            disabled={links.length >= MAX_FOOTER_LINKS}
            className="cursor-pointer rounded-[9px] border border-accent px-4 py-2 text-[13px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-50"
          >
            {t("ftAddLink")}
          </button>
        </div>

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
