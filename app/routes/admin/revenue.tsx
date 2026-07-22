// Revenue management — connection page. The hotelier links their own Channex
// account (personal user-api-key); we import the property's full booking
// history (all channels, incl. OTAs) into the per-night D1 store and keep it
// fresh via cron. The analytics dashboards build on top of this data.
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/revenue";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminDateLocale, useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { fmtDate } from "~/lib/dates";
import { currentPropertyId } from "~/lib/properties.server";
import {
  connectRevman,
  disconnectRevman,
  getRevmanState,
  getRevmanSummary,
  importRevmanBookings,
  setRevmanRoomCount,
} from "~/lib/revman.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { configured: false as const };
  const state = await getRevmanState(pid);
  const summary = state ? await getRevmanSummary(pid) : undefined;
  return { configured: true as const, state, summary };
}

export function meta() {
  return [{ title: "Admin · Revenue" }];
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { error: "Select a property first." };
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "connect") {
      const apiKey = String(form.get("apiKey") || "").trim();
      if (!apiKey) return { errorKey: "revErrNoKey" as const };
      const channexPropertyId = String(form.get("channexPropertyId") || "") || undefined;
      const result = await connectRevman(pid, apiKey, channexPropertyId);
      if (result.pickFrom) return { pick: result.pickFrom, apiKey };
      return { okKey: "revConnected" as const };
    }
    if (intent === "refresh" || intent === "refreshFull") {
      const imported = await importRevmanBookings(pid, { full: intent === "refreshFull" });
      return { okKey: "revRefreshed" as const, imported };
    }
    if (intent === "roomCount") {
      const n = Number(form.get("roomCount"));
      if (!Number.isFinite(n) || n < 1) return { errorKey: "revErrRoomCount" as const };
      await setRevmanRoomCount(pid, n);
      return { okKey: "revSaved" as const };
    }
    if (intent === "disconnect") {
      await disconnectRevman(pid);
      return { okKey: "revDisconnected" as const };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong. Try again." };
  }
  return null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-line bg-surface p-5">
      <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className="mt-1.5 font-serif text-[24px] font-semibold text-ink">{value}</div>
    </div>
  );
}

export default function AdminRevenue({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const dl = useAdminDateLocale();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const busyIntent = busy ? String(nav.formData?.get("intent") ?? "") : "";

  if (!loaderData.configured) {
    return (
      <div>
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("revTitle")}</h1>
        <p className="text-[14px] text-muted">
          {t("anSelectPropertyPrefix")}{" "}
          <Link to="/admin/select-property" className="text-accent underline">
            {t("anSelectPropertyLink")}
          </Link>
          .
        </p>
      </div>
    );
  }

  const { state, summary } = loaderData;
  const pick = actionData && "pick" in actionData && actionData.pick ? { pick: actionData.pick, apiKey: actionData.apiKey } : undefined;

  return (
    <div className="max-w-[860px]">
      <h1 className="font-serif text-[26px] font-semibold">{t("revTitle")}</h1>
      <p className="mb-6 mt-1 text-[13.5px] text-muted">{t("revSubtitle")}</p>

      {actionData && "error" in actionData && actionData.error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700">
          {actionData.error}
        </p>
      )}
      {actionData && "errorKey" in actionData && actionData.errorKey && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700">
          {t(actionData.errorKey)}
        </p>
      )}
      {actionData && "okKey" in actionData && actionData.okKey && (
        <p className="mb-4 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-800">
          {actionData.okKey === "revRefreshed"
            ? t("revRefreshed", { count: String(actionData.imported ?? 0) })
            : t(actionData.okKey)}
        </p>
      )}

      {!state ? (
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <h2 className="font-serif text-[19px] font-semibold">{t("revConnectTitle")}</h2>
          <p className="mt-2 max-w-[560px] text-[13.5px] leading-relaxed text-muted">{t("revConnectBody")}</p>
          <p className="mt-2 max-w-[560px] text-[12.5px] leading-relaxed text-faint">{t("revKeyStorageNote")}</p>

          {pick ? (
            <Form method="post" className="mt-5">
              <input type="hidden" name="intent" value="connect" />
              <input type="hidden" name="apiKey" value={pick.apiKey} />
              <p className="mb-3 text-[13.5px] text-secondary">{t("revPickBody")}</p>
              <div className="flex flex-col gap-2">
                {pick.pick.map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3 text-[14px]"
                  >
                    <input type="radio" name="channexPropertyId" value={p.id} required className="accent-accent" />
                    <span className="font-semibold text-ink">{p.title}</span>
                    <span className="text-[12px] text-faint">{p.id}</span>
                  </label>
                ))}
              </div>
              <button
                type="submit"
                disabled={busy}
                className="mt-4 rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white disabled:opacity-60"
              >
                {busyIntent === "connect" ? t("revImporting") : t("revConnectCta")}
              </button>
            </Form>
          ) : (
            <Form method="post" className="mt-5 max-w-[560px]">
              <input type="hidden" name="intent" value="connect" />
              <label className="block text-[13px] font-semibold text-secondary">
                {t("revKeyLabel")}
                <input name="apiKey" required autoComplete="off" className={FIELD_INPUT} />
              </label>
              <p className="mt-1.5 text-[12px] text-faint">{t("revKeyHelp")}</p>
              <button
                type="submit"
                disabled={busy}
                className="mt-4 rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white disabled:opacity-60"
              >
                {busyIntent === "connect" ? t("revImporting") : t("revConnectCta")}
              </button>
            </Form>
          )}
        </section>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label={t("revStatNights")} value={String(summary?.nights ?? 0)} />
            <Stat label={t("revStatBookings")} value={String(summary?.bookings ?? 0)} />
            <Stat label={t("revStatCancelled")} value={String(summary?.cancelledBookings ?? 0)} />
          </div>

          <section className="mt-4 rounded-[14px] border border-line bg-surface p-6">
            <h2 className="font-serif text-[19px] font-semibold">{t("revConnectionTitle")}</h2>
            <dl className="mt-3 grid gap-x-8 gap-y-2 text-[13.5px] sm:grid-cols-2">
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-muted">{t("revDataAsOf")}</dt>
                <dd className="font-semibold text-ink">
                  {state.lastImportAt ? fmtDate(state.lastImportAt.slice(0, 10), "d MMM yyyy", dl) : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-muted">{t("revStaySpan")}</dt>
                <dd className="font-semibold text-ink">
                  {summary?.firstStay && summary.lastStay
                    ? `${fmtDate(summary.firstStay, "d MMM yyyy", dl)} – ${fmtDate(summary.lastStay, "d MMM yyyy", dl)}`
                    : "—"}
                </dd>
              </div>
            </dl>
            {state.importStatus === "error" && state.error && (
              <p className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
                {t("revLastImportFailed", { error: state.error })}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Form method="post">
                <input type="hidden" name="intent" value="refresh" />
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-[10px] bg-accent px-4 py-2 text-[13.5px] font-semibold text-white disabled:opacity-60"
                >
                  {busyIntent === "refresh" ? t("revImporting") : t("revRefreshCta")}
                </button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="refreshFull" />
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-[10px] border border-line-alt px-4 py-2 text-[13.5px] font-semibold text-secondary hover:bg-chip disabled:opacity-60"
                >
                  {busyIntent === "refreshFull" ? t("revImporting") : t("revRefreshFullCta")}
                </button>
              </Form>
              <span className="text-[12.5px] text-faint">{t("revAutoRefreshNote")}</span>
            </div>
          </section>

          <section className="mt-4 rounded-[14px] border border-line bg-surface p-6">
            <h2 className="font-serif text-[19px] font-semibold">{t("revRoomCountTitle")}</h2>
            <p className="mt-1 max-w-[560px] text-[13px] text-muted">{t("revRoomCountHelp")}</p>
            <Form method="post" className="mt-3 flex items-end gap-3">
              <input type="hidden" name="intent" value="roomCount" />
              <label className="block text-[13px] font-semibold text-secondary">
                {t("revRoomCountLabel")}
                <input
                  name="roomCount"
                  type="number"
                  min={1}
                  defaultValue={state.roomCount}
                  className={`${FIELD_INPUT} w-28`}
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="rounded-[10px] border border-line-alt px-4 py-[11px] text-[13.5px] font-semibold text-secondary hover:bg-chip disabled:opacity-60"
              >
                {t("revSaveCta")}
              </button>
            </Form>
          </section>

          <section className="mt-4 rounded-[14px] border border-line bg-surface p-6">
            <p className="text-[13px] text-muted">{t("revComingSoon")}</p>
          </section>

          <section className="mt-4 rounded-[14px] border border-line bg-surface p-6">
            <h2 className="font-serif text-[16px] font-semibold text-secondary">{t("revDisconnectTitle")}</h2>
            <p className="mt-1 max-w-[560px] text-[13px] text-muted">{t("revDisconnectBody")}</p>
            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm(t("revDisconnectConfirm"))) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="disconnect" />
              <button
                type="submit"
                disabled={busy}
                className="mt-3 rounded-[10px] border border-red-200 px-4 py-2 text-[13.5px] font-semibold text-[#c0392b] hover:bg-red-50 disabled:opacity-60"
              >
                {t("revDisconnectCta")}
              </button>
            </Form>
          </section>
        </>
      )}
    </div>
  );
}
