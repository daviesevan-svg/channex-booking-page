import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/portal";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings, savePortalSettings } from "~/lib/overrides.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  return { configured: true as const, settings: await getSettings(propertyId) };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  await savePortalSettings(propertyId, await request.formData());
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Customer Portal" }];
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
  const checkbox =
    "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{t("poTitle")}</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            {t("saved")}
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">
        {t("poIntro")}
      </p>

      <Form
        method="post"
        className="flex flex-col gap-6 rounded-[14px] border border-line bg-surface p-6"
      >
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
        <label className="flex items-start gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" name="autoRefund" defaultChecked={s.autoRefund} className={checkbox} />
          <span>
            {t("poAutoRefund")}
            <span className="mt-0.5 block text-[12.5px] font-normal text-muted">
              {t("poAutoRefundHint")}
            </span>
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
            defaultValue={s.afterDeadlineMessage}
            placeholder={t("poAfterDeadlinePlaceholder")}
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
