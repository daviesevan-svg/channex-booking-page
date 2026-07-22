import { Link, useSearchParams } from "react-router";

import type { Route } from "./+types/analytics";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSearchAnalytics } from "~/lib/search-analytics.server";
import { COUNTRIES } from "~/lib/countries";
import { useAdminLang, useAdminT } from "~/lib/admin-i18n";

const WINDOWS = [
  { days: 30, labelKey: "anWindow30" },
  { days: 90, labelKey: "anWindow90" },
  { days: 365, labelKey: "anWindow365" },
];

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const url = new URL(request.url);
  const days = WINDOWS.some((w) => w.days === Number(url.searchParams.get("days")))
    ? Number(url.searchParams.get("days"))
    : 30;

  const data = await getSearchAnalytics(propertyId, days);
  return { configured: true as const, days, data };
}

export function meta() {
  return [{ title: "Admin · Search analytics" }];
}

const countryName = (code: string, unknown: string) =>
  code === "??" ? unknown : COUNTRIES.find((c) => c.code === code)?.name ?? code;

const DOW = ["anDowSun", "anDowMon", "anDowTue", "anDowWed", "anDowThu", "anDowFri", "anDowSat"];

const fmtDate = (iso: string, lang: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[14px] border border-line bg-surface p-6">
      <div className="font-serif text-[18px] font-semibold">{title}</div>
      {sub && <p className="mb-4 mt-1 text-[13px] text-muted">{sub}</p>}
      {!sub && <div className="mb-4" />}
      {children}
    </section>
  );
}

/** Horizontal bar list — the workhorse of this page. */
function Bars({
  rows,
  max,
}: {
  rows: { label: string; value: number; note?: string }[];
  max?: number;
}) {
  const t = useAdminT();
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="text-[13.5px] text-muted">{t("anNoDataYet")}</p>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-[110px] flex-none text-[13px] text-secondary">{r.label}</span>
          <div className="h-[18px] flex-1 rounded-[5px] bg-chip">
            <div
              className="h-full rounded-[5px] bg-accent/70"
              style={{ width: `${Math.max(2, (r.value / top) * 100)}%` }}
            />
          </div>
          <span className="w-[70px] flex-none text-right text-[13px] font-semibold tabular-nums">
            {r.value}
            {r.note && <span className="ml-1 font-normal text-muted">{r.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[14px] border border-line bg-surface p-5">
      <div className="text-[12.5px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 font-serif text-[28px] font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-muted">{sub}</div>}
    </div>
  );
}

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const [, setSearchParams] = useSearchParams();
  const t = useAdminT();
  const lang = useAdminLang();

  if (!loaderData.configured) {
    return (
      <div>
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("anTitle")}</h1>
        <p className="text-[14px] text-muted">
          {t("anSelectPropertyPrefix")} <Link to="/admin/select-property" className="text-accent underline">{t("anSelectPropertyLink")}</Link>.
        </p>
      </div>
    );
  }

  const { days, data } = loaderData;
  const { totals } = data;
  const lostShare = totals.searches > 0 ? Math.round((totals.lost / totals.searches) * 100) : 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold">{t("anTitle")}</h1>
          <p className="mt-1 text-[13.5px] text-muted">{t("anSubtitle")}</p>
        </div>
        <div className="flex gap-1 rounded-[10px] border border-line-alt bg-surface p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setSearchParams(w.days === 30 ? {} : { days: String(w.days) })}
              className={`rounded-[8px] px-3 py-1.5 text-[13px] font-semibold ${
                days === w.days ? "bg-accent text-white" : "text-secondary hover:bg-field-hover"
              }`}
            >
              {t(w.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {totals.searches === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-8 text-center">
          <div className="font-serif text-[18px] font-semibold">{t("anEmptyTitle")}</div>
          <p className="mx-auto mt-2 max-w-[440px] text-[13.5px] text-muted">{t("anEmptyBody")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi label={t("anKpiSearches")} value={String(totals.searches)} sub={t("anKpiLastDays", { n: days })} />
            <Kpi
              label={t("anKpiFoundNothing")}
              value={`${lostShare}%`}
              sub={t("anKpiLostSub", { n: totals.lost })}
            />
            <Kpi
              label={t("anBookingWindow")}
              value={totals.avgLeadDays == null ? "—" : t("anLeadDaysShort", { n: totals.avgLeadDays })}
              sub={t("anKpiWindowSub")}
            />
            <Kpi
              label={t("anKpiStay")}
              value={totals.avgNights == null ? "—" : `${totals.avgNights}`}
              sub={t("anKpiStaySub", { party: totals.avgParty ?? "—" })}
            />
          </div>

          {/* Lost demand — the actionable one, so it goes first when present. */}
          {data.lostDates.length > 0 && (
            <Card title={t("anLostTitle")} sub={t("anLostSub")}>
              <Bars
                rows={data.lostDates.map((d) => ({
                  label: fmtDate(d.checkin, lang),
                  value: Number(d.lost),
                  note: `/ ${d.total}`,
                }))}
              />
            </Card>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title={t("anTopArrivalsTitle")} sub={t("anTopArrivalsSub")}>
              <Bars
                rows={data.topArrivals.slice(0, 10).map((d) => ({
                  label: fmtDate(d.checkin, lang),
                  value: Number(d.searches),
                }))}
              />
            </Card>

            <Card title={t("anArrivalDowTitle")} sub={t("anArrivalDowSub")}>
              <Bars
                rows={[1, 2, 3, 4, 5, 6, 0].map((dow) => ({
                  label: t(DOW[dow]),
                  value: Number(data.arrivalDow.find((r) => r.dow === dow)?.searches ?? 0),
                }))}
              />
            </Card>

            <Card title={t("anBookingWindow")} sub={t("anWindowSub")}>
              <Bars
                rows={data.leadBuckets.map((b) => ({ label: b.bucket, value: Number(b.searches) }))}
              />
            </Card>

            <Card title={t("anLosTitle")} sub={t("anLosSub")}>
              <Bars
                rows={data.losBuckets.map((b) => ({ label: b.bucket, value: Number(b.searches) }))}
              />
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title={t("anCountriesTitle")} sub={t("anCountriesSub")}>
              <Bars
                rows={data.countries.map((c) => ({
                  label: countryName(c.country, t("anCountryUnknown")),
                  value: Number(c.searches),
                }))}
              />
            </Card>

            <Card title={t("anActivityTitle")} sub={t("anActivitySub")}>
              {data.perDay.length === 0 ? (
                <p className="text-[13.5px] text-muted">{t("anNoDataYet")}</p>
              ) : (
                <div className="flex h-[160px] items-end gap-[2px]">
                  {data.perDay.map((d) => {
                    const top = Math.max(1, ...data.perDay.map((x) => Number(x.searches)));
                    return (
                      <div
                        key={d.day}
                        title={`${d.day}: ${t(Number(d.searches) === 1 ? "anSearchCount_one" : "anSearchCount_other", { n: d.searches })}`}
                        className="flex-1 rounded-t-[3px] bg-accent/70 hover:bg-accent"
                        style={{ height: `${Math.max(3, (Number(d.searches) / top) * 100)}%` }}
                      />
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
