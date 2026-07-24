import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/rate-intel.settings";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getRevmanState } from "~/lib/revman.server";
import { getCaptureSettings, setCaptureSettings } from "~/lib/revman-comp-capture.server";
import { getCompSet } from "~/lib/revman-compset.server";
import { getBalance } from "~/lib/revman-tokens.server";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { configured: false as const };
  const state = await getRevmanState(pid);
  if (!state) return { configured: true as const, connected: false as const };
  const [settings, balance, set] = await Promise.all([getCaptureSettings(pid), getBalance(pid), getCompSet(pid)]);
  const hotelCount = set.ranked.filter((h) => Boolean(h.bookingRef)).length;
  return { configured: true as const, connected: true as const, settings, balance, hotelCount };
}

export function meta() {
  return [{ title: "Admin · Rate intelligence settings" }];
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { error: "Select a property first." };
  const form = await request.formData();
  await setCaptureSettings(pid, {
    enabled: form.get("enabled") === "on",
    horizonDays: Number(form.get("horizonDays")),
    nearDays: Number(form.get("nearDays")),
    farCadenceDays: Number(form.get("farCadenceDays")),
  });
  return { okKey: "riSaved" as const };
}

const FIELD = "rounded-[9px] border border-line-alt bg-surface px-3 py-2 text-[14px]";

export default function RateIntelSettings({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  if (!loaderData.configured || !loaderData.connected) {
    return (
      <div>
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("riSettingsTitle")}</h1>
        <p className="text-[14px] text-muted">
          {t("riConnectPrefix")}{" "}
          <Link to="/admin/revenue" className="text-accent underline">{t("navRevenue")}</Link>.
        </p>
      </div>
    );
  }

  const { settings, hotelCount } = loaderData;
  // Rough monthly burn: (near dates daily + far dates every farCadence) × hotels
  // priced (one token per hotel per day).
  const far = Math.max(0, settings.horizonDays - settings.nearDays);
  const perHotel = settings.nearDays * 30 + (far / settings.farCadenceDays) * 30;
  const monthlyTokens = Math.round(perHotel * Math.max(1, hotelCount));

  return (
    <div className="max-w-[640px]">
      <div className="mb-1 text-[13px]">
        <Link to="/admin/rate-intel" className="text-accent hover:underline">← {t("riBack")}</Link>
      </div>
      <h1 className="font-serif text-[26px] font-semibold">{t("riSettingsTitle")}</h1>
      <p className="mt-1 text-[13.5px] text-muted">{t("riSettingsSub")}</p>

      {actionData && "okKey" in actionData && actionData.okKey && (
        <p className="mt-4 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-800">{t(actionData.okKey)}</p>
      )}

      <Form method="post" className="mt-5 flex flex-col gap-5">
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <label className="flex items-center gap-3">
            <input type="checkbox" name="enabled" defaultChecked={settings.enabled} className="h-4 w-4" />
            <span>
              <span className="text-[14px] font-semibold">{t("riSetEnabled")}</span>
              <span className="block text-[12.5px] text-muted">{t("riSetEnabledSub")}</span>
            </span>
          </label>

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="text-[13px] font-medium text-secondary">
              {t("riSetHorizon")}
              <select name="horizonDays" defaultValue={String(settings.horizonDays)} className={`${FIELD} mt-1 block w-full`}>
                <option value="30">{t("riDays", { n: "30" })}</option>
                <option value="60">{t("riDays", { n: "60" })}</option>
                <option value="90">{t("riDays", { n: "90" })}</option>
                <option value="180">{t("riDays", { n: "180" })}</option>
                <option value="365">{t("riDays", { n: "365" })}</option>
              </select>
              <span className="mt-1 block text-[12px] text-muted">{t("riSetHorizonSub")}</span>
            </label>

            <label className="text-[13px] font-medium text-secondary">
              {t("riSetNear")}
              <input type="number" name="nearDays" min={1} max={365} defaultValue={settings.nearDays} className={`${FIELD} mt-1 block w-full`} />
              <span className="mt-1 block text-[12px] text-muted">{t("riSetNearSub")}</span>
            </label>

            <label className="text-[13px] font-medium text-secondary">
              {t("riSetFar")}
              <select name="farCadenceDays" defaultValue={String(settings.farCadenceDays)} className={`${FIELD} mt-1 block w-full`}>
                <option value="1">{t("riCadDaily")}</option>
                <option value="7">{t("riCadWeekly")}</option>
                <option value="14">{t("riCadBiweekly")}</option>
                <option value="30">{t("riCadMonthly")}</option>
              </select>
              <span className="mt-1 block text-[12px] text-muted">{t("riSetFarSub")}</span>
            </label>
          </div>

          <div className="mt-4 rounded-[10px] bg-chip/50 px-4 py-3 text-[13px]">
            <span className="text-muted">{t("riEstBurn")}:</span>{" "}
            <span className="font-semibold tabular-nums">{t("riEstBurnVal", { n: monthlyTokens.toLocaleString() })}</span>
            <span className="ml-1 text-muted">({t("riEstBurnNote")})</span>
          </div>
        </section>

        {/* Future settings live here (alerts, currency, LOS, guest mix, …). */}
        <section className="rounded-[14px] border border-dashed border-line-alt bg-surface p-6 text-[13px] text-muted">
          <div className="font-semibold text-secondary">{t("riFutureTitle")}</div>
          <p className="mt-1">{t("riFutureSub")}</p>
        </section>

        <div>
          <button type="submit" disabled={busy} className="rounded-[10px] bg-accent px-6 py-2.5 text-[14px] font-semibold text-white disabled:opacity-60">
            {t("riSave")}
          </button>
        </div>
      </Form>
    </div>
  );
}
