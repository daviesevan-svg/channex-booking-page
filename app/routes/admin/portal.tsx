import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/portal";
import { adminMeta } from "~/lib/admin-meta";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { DEFAULT_CANCEL_ANCHOR } from "~/lib/dates";
import { DEFAULT_LANG, langParam, pickLang } from "~/lib/content";
import {
  getPortalMessageRaw,
  getSettings,
  savePortalSettings,
  savePortalTranslation,
} from "~/lib/overrides.server";
import { TranslationNote } from "~/components/admin-form";
import { AdminPageHeader } from "~/components/admin-page-header";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  // The header's "Editing: [language]" switcher sets ?lang — the message below
  // is guest-facing copy, so it is edited per language like every other one.
  const lang = langParam(request);
  const [settings, message, canOwn] = await Promise.all([
    getSettings(propertyId),
    getPortalMessageRaw(propertyId, lang),
    isOwnerOrSuper(request, propertyId),
  ]);
  return { configured: true as const, settings, lang, message: message ?? "", canOwn };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  const canOwn = await isOwnerOrSuper(request, propertyId);
  const form = await request.formData();
  // The toggles and deadlines are language-independent and save from any tab.
  // The message is not: on a translation tab it belongs in that language's
  // entry, and the original must be left exactly as it was.
  const lang = pickLang(String(form.get("lang") ?? ""));
  const onDefault = lang === DEFAULT_LANG;
  // Auto-refund is owner-only. Cancel/modify windows and copy stay teammate-ok;
  // a teammate POST that includes autoRefund must not persist that field.
  await savePortalSettings(propertyId, form, { persistAutoRefund: canOwn, persistMessage: onDefault });
  if (!onDefault) {
    await savePortalTranslation(propertyId, lang, String(form.get("afterDeadlineMessage") ?? ""));
  }
  return { ok: true };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navPortal" });
}

function Deadline({
  label,
  hint,
  nameValue,
  nameUnit,
  value,
  unit,
}: {
  label: string;
  hint: string;
  nameValue: string;
  nameUnit: string;
  value?: number;
  unit?: string;
}) {
  const t = useAdminT();
  return (
    <div>
      <div className="text-[13px] font-semibold text-secondary">{label}</div>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          name={nameValue}
          type="number"
          min={0}
          defaultValue={value ?? ""}
          placeholder="0"
          className="w-24 rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[10px] text-[15px] text-ink outline-none focus:border-accent"
        />
        <select
          name={nameUnit}
          defaultValue={unit ?? "days"}
          className="rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
        >
          <option value="days">{t("poDays")}</option>
          <option value="hours">{t("poHours")}</option>
        </select>
        <span className="text-[13px] text-muted-2">{t("poBeforeArrival")}</span>
      </div>
      <p className="mt-1 text-[11px] text-faint">{hint}</p>
    </div>
  );
}

export default function AdminPortal({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const t = useAdminT();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("poTitle")}</h1>
        <p className="text-[15px] text-secondary">
          {t("poConfigurePrefix")} <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code>{" "}
          {t("poConfigureSuffix")}
        </p>
      </div>
    );
  }

  const s = loaderData.settings;
  const canOwn = loaderData.canOwn;
  const { lang, message } = loaderData;
  const onDefault = lang === DEFAULT_LANG;
  const checkbox =
    "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";

  return (
    <div>
      <AdminPageHeader title={t("poTitle")} saved={Boolean(actionData?.ok)} className="mb-1" />
      <p className="mb-6 text-[14px] text-muted">
        {t("poIntro")}
      </p>

      <TranslationNote lang={lang} />

      {/* key={lang} remounts the form on a language switch so the message field
          picks up that language's stored text instead of keeping the last. */}
      <Form
        key={lang}
        method="post"
        className="flex flex-col gap-6 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <label className="flex items-center gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" name="allowCancel" defaultChecked={s.allowCancel} className={checkbox} />
          {t("poAllowCancel")}
        </label>
        <Deadline
          label={t("poCancelUpTo")}
          hint={t("poCancelHint")}
          nameValue="cancelDeadlineValue"
          nameUnit="cancelDeadlineUnit"
          value={s.cancelDeadlineValue}
          unit={s.cancelDeadlineUnit}
        />
        {/* The wall-clock the deadline counts back from. Its own field because a
            deadline in hours is meaningless without it: 24 hours before arrival is
            6pm the previous evening here, not midnight. */}
        <label className="block text-[14px] font-semibold">
          {t("poCancelAnchor")}
          <input
            name="cancelAnchorTime"
            type="time"
            defaultValue={s.cancelAnchorTime || DEFAULT_CANCEL_ANCHOR}
            className="mt-1.5 block w-40 rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[10px] text-[15px] text-ink outline-none focus:border-accent"
          />
          <span className="mt-1 block text-[12px] font-normal text-muted">
            {t("poCancelAnchorHint")}
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-[14px] font-semibold">
          {canOwn ? (
            <input type="checkbox" name="autoRefund" defaultChecked={s.autoRefund} className={checkbox} />
          ) : (
            <input type="checkbox" checked={Boolean(s.autoRefund)} disabled className={checkbox} />
          )}
          <span>
            {t("poAutoRefund")}
            <span className="mt-0.5 block text-[12px] font-normal text-muted">
              {t("poAutoRefundHint")}
            </span>
            {!canOwn && <span className="mt-0.5 block text-[12px] font-normal text-faint">{t("ownerOnlyHint")}</span>}
          </span>
        </label>

        <div className="border-t border-divider" />

        <label className="flex items-center gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" name="allowModify" defaultChecked={s.allowModify} className={checkbox} />
          {t("poAllowModify")} <span className="text-[12px] font-normal text-faint">{t("poComingSoon")}</span>
        </label>
        <Deadline
          label={t("poModifyUpTo")}
          hint={t("poModifyHint")}
          nameValue="modifyDeadlineValue"
          nameUnit="modifyDeadlineUnit"
          value={s.modifyDeadlineValue}
          unit={s.modifyDeadlineUnit}
        />

        <div className="border-t border-divider" />

        <label className="block text-[13px] font-semibold text-secondary">
          {t("poAfterDeadline")}
          <textarea
            name="afterDeadlineMessage"
            rows={2}
            defaultValue={message}
            // Placeholders belong on the default tab only: inside an empty
            // translation field the English example reads as untranslated copy.
            placeholder={onDefault ? t("poAfterDeadlinePlaceholder") : undefined}
            className="mt-1.5 block w-full resize-y rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            {t("poAfterDeadlineHint")}
          </span>
        </label>

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? t("saving") : t("poSaveSettings")}
          </button>
        </div>
      </Form>
    </div>
  );
}
