import { Link, redirect, useSearchParams } from "react-router";

import type { Route } from "./+types/collection-analytics";
import { requireAdmin } from "~/lib/auth.server";
import { getVisibleCollections } from "~/lib/collections.server";
import { getCollectionAnalytics } from "~/lib/collection-analytics.server";
import { getProperties } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { COUNTRIES } from "~/lib/countries";
import { useAdminLang, useAdminT } from "~/lib/admin-i18n";

const WINDOWS = [
  { days: 30, labelKey: "anWindow30" },
  { days: 90, labelKey: "anWindow90" },
  { days: 365, labelKey: "anWindow365" },
];

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const collection = (await getVisibleCollections(request)).find((c) => c.slug === params.slug);
  if (!collection) throw redirect("/admin/collections");

  const url = new URL(request.url);
  const days = WINDOWS.some((w) => w.days === Number(url.searchParams.get("days")))
    ? Number(url.searchParams.get("days"))
    : 30;

  const data = await getCollectionAnalytics(collection.slug, days);

  // Resolve member property ids → display names for the "most-clicked" chart.
  const names = new Map((await getProperties()).map((p) => [p.id, p.name]));
  const topProperties = data.topProperties.map((r) => ({
    name: names.get(r.propertyId) ?? r.propertyId,
    clicks: Number(r.clicks),
  }));

  const appUrl = getConfig().appUrl.replace(/\/+$/, "");
  return {
    collection: { name: collection.name, slug: collection.slug },
    landingUrl: `${appUrl}/c/${collection.slug}`,
    days,
    data,
    topProperties,
  };
}

export function meta() {
  return [{ title: "Admin · Collection analytics" }];
}

const countryName = (code: string, unknown: string) =>
  code === "??" ? unknown : COUNTRIES.find((c) => c.code === code)?.name ?? code;

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
function Bars({ rows, max }: { rows: { label: string; value: number; note?: string }[]; max?: number }) {
  const t = useAdminT();
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="text-[13.5px] text-muted">{t("anNoDataYet")}</p>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-[130px] flex-none truncate text-[13px] text-secondary" title={r.label}>
            {r.label}
          </span>
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

export default function CollectionAnalytics({ loaderData }: Route.ComponentProps) {
  const [, setSearchParams] = useSearchParams();
  const t = useAdminT();
  const lang = useAdminLang();
  const { collection, landingUrl, days, data, topProperties } = loaderData;
  const { totals } = data;

  const searchShare = totals.views > 0 ? Math.round((totals.searches / totals.views) * 100) : 0;
  const ctr = totals.views > 0 ? Math.round((totals.clicks / totals.views) * 100) : 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-3 text-[13px]">
            <Link to={`/admin/collections/${collection.slug}`} className="text-accent hover:underline">
              ← {t("caBack")}
            </Link>
            <a href={landingUrl} target="_blank" rel="noreferrer" className="text-muted hover:text-accent hover:underline">
              {t("caViewPage")} ↗
            </a>
          </div>
          <h1 className="font-serif text-[26px] font-semibold">{t("caTitle")}</h1>
          <p className="mt-1 text-[13.5px] text-muted">{t("caSubtitle", { name: collection.name })}</p>
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

      {totals.views === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-8 text-center">
          <div className="font-serif text-[18px] font-semibold">{t("caEmptyTitle")}</div>
          <p className="mx-auto mt-2 max-w-[460px] text-[13.5px] text-muted">{t("caEmptyBody")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi label={t("caKpiViews")} value={String(totals.views)} sub={t("caKpiViewsSub", { n: days })} />
            <Kpi
              label={t("caKpiSearches")}
              value={String(totals.searches)}
              sub={t("caKpiSearchesSub", { n: searchShare })}
            />
            <Kpi label={t("caKpiClicks")} value={String(totals.clicks)} sub={t("caKpiClicksSub")} />
            <Kpi label={t("caKpiCtr")} value={`${ctr}%`} sub={t("caKpiCtrSub")} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title={t("caTopPropsTitle")} sub={t("caTopPropsSub")}>
              <Bars rows={topProperties.map((p) => ({ label: p.name, value: p.clicks }))} />
            </Card>

            <Card title={t("caActivityTitle")} sub={t("caActivitySub")}>
              {data.perDay.length === 0 ? (
                <p className="text-[13.5px] text-muted">{t("anNoDataYet")}</p>
              ) : (
                <div className="flex h-[160px] items-end gap-[2px]">
                  {data.perDay.map((d) => {
                    const top = Math.max(1, ...data.perDay.map((x) => Number(x.views)));
                    return (
                      <div
                        key={d.day}
                        title={`${d.day}: ${t(Number(d.views) === 1 ? "caViewCount_one" : "caViewCount_other", { n: d.views })}`}
                        className="flex-1 rounded-t-[3px] bg-accent/70 hover:bg-accent"
                        style={{ height: `${Math.max(3, (Number(d.views) / top) * 100)}%` }}
                      />
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title={t("anBookingWindow")} sub={t("anWindowSub")}>
              <Bars rows={data.leadBuckets.map((b) => ({ label: b.bucket, value: Number(b.searches) }))} />
            </Card>

            <Card title={t("anLosTitle")} sub={t("anLosSub")}>
              <Bars rows={data.losBuckets.map((b) => ({ label: b.bucket, value: Number(b.searches) }))} />
            </Card>

            <Card title={t("anCountriesTitle")} sub={t("anCountriesSub")}>
              <Bars
                rows={data.countries.map((c) => ({
                  label: countryName(c.country, t("anCountryUnknown")),
                  value: Number(c.views),
                }))}
              />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
