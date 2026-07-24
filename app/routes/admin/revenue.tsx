// Revenue management — connection page. The hotelier links their own Channex
// account (personal user-api-key); we import the property's full booking
// history (all channels, incl. OTAs) into the per-night D1 store and keep it
// fresh via cron. The analytics dashboards build on top of this data.
import { useEffect, useState } from "react";
import { Form, Link, useNavigation, useRevalidator } from "react-router";

import type { Route } from "./+types/revenue";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminDateLocale, useAdminT, type AdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { fmtDate, todayISODate } from "~/lib/dates";
import { formatMoney } from "~/lib/money";
import { currentPropertyId } from "~/lib/properties.server";
import {
  applyPriceSuggestions,
  getForecast,
  getPaceCalendar,
  getPriceSuggestions,
  getRevmanKpis,
  type Kpi,
  type PaceDay,
  type PriceSuggestionRow,
} from "~/lib/revman-analytics.server";
import type { SalesScore } from "~/lib/revman-pace";
import { guardsReady } from "~/lib/revman-price";
import {
  addCompetitor,
  getCompSet,
  removeCompetitor,
  updateCompetitor,
  type CompSetView,
} from "~/lib/revman-compset.server";
import { discoverCompetitors, type CandidateHotel } from "~/lib/revman-compset-discovery.server";
import { isScrapflyConfigured } from "~/lib/scrapfly.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { importLooksStalled } from "~/lib/revman";
import {
  connectRevman,
  disconnectRevman,
  getRevmanState,
  getRevmanSummary,
  importRevmanBookings,
  nudgeRevmanImport,
  setRevmanPriceGuards,
  setRevmanRoomCount,
} from "~/lib/revman.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { configured: false as const };
  const state = await getRevmanState(pid);
  const summary = state ? await getRevmanSummary(pid) : undefined;
  const today = todayISODate();
  const hasData = Boolean(state && summary && summary.nights > 0);
  const kpis = state && hasData ? await getRevmanKpis(pid, today, state.roomCount) : undefined;

  // Pace calendar month (?month=YYYY-MM, defaults to the current month).
  const monthParam = new URL(request.url).searchParams.get("month");
  const paceMonth = monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : today.slice(0, 7);
  const paceFrom = `${paceMonth}-01`;
  const paceTo = new Date(Date.UTC(Number(paceMonth.slice(0, 4)), Number(paceMonth.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
  // Forecast covers the current month (chart overlay) through 30 days out.
  // Computed before the pace calendar so warning scores can clear to
  // "filling up" on dates the forecast expects to fill.
  const monthFrom = `${today.slice(0, 8)}01`;
  const forecastTo = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  const forecast = state && hasData ? await getForecast(pid, monthFrom, forecastTo, state.roomCount, today) : undefined;

  const paceDays =
    state && hasData
      ? await getPaceCalendar(
          pid,
          paceFrom,
          paceTo,
          today,
          state.roomCount,
          forecast ? new Map(forecast.map((f) => [f.date, f.forecastPercent])) : undefined,
        )
      : undefined;

  const guards = { minPrice: state?.minPrice, maxPrice: state?.maxPrice };
  const suggestions =
    state && hasData ? await getPriceSuggestions(pid, today, state.roomCount, guards) : undefined;

  const stalled = state ? importLooksStalled(state) : false;

  // Backup driver for the chunked import: while the page polls, each load
  // nudges the chain along if the self-fetch continuation died (drive-by mode
  // skips when another chunk runner looks alive).
  if (state?.importStatus === "running" && state.cursor) nudgeRevmanImport(pid);

  const compSet = state ? await getCompSet(pid) : undefined;
  // Default the discovery search to the property's own town/region, so the
  // owner usually just clicks "Find competitors".
  let compArea = "";
  if (state) {
    const settings = await getSettings(pid);
    compArea = [settings.addressCity, settings.addressRegion, settings.addressCountry]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(", ");
  }

  return {
    configured: true as const,
    state,
    summary,
    kpis,
    today,
    paceMonth,
    paceDays,
    forecast,
    suggestions,
    stalled,
    compSet,
    compArea,
    scrapflyOn: isScrapflyConfigured(),
  };
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
      await importRevmanBookings(pid, { full: intent === "refreshFull" });
      return { okKey: "revImportStarted" as const };
    }
    if (intent === "priceGuards") {
      const min = Number(form.get("minPrice"));
      const max = Number(form.get("maxPrice"));
      if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
        return { errorKey: "revErrGuards" as const };
      }
      await setRevmanPriceGuards(pid, min, max);
      return { okKey: "revSaved" as const };
    }
    if (intent === "applyPrice" || intent === "applyPriceAll") {
      const state = await getRevmanState(pid);
      if (!state) return { error: "Revenue management is not connected." };
      const email = await requireAdmin(request);
      const today = todayISODate();
      const dates =
        intent === "applyPrice"
          ? [String(form.get("date"))]
          : (await getPriceSuggestions(pid, today, state.roomCount, state)).filter((s) => s.pct !== 0).map((s) => s.date);
      const result = await applyPriceSuggestions(pid, dates, today, state.roomCount, state, {
        source: "revman",
        actor: email,
      });
      if (result.cells === 0) return { okKey: "revSugNothing" as const };
      return { okKey: "revSugApplied" as const, applied: result };
    }
    if (intent === "roomCount") {
      const n = Number(form.get("roomCount"));
      if (!Number.isFinite(n) || n < 1) return { errorKey: "revErrRoomCount" as const };
      await setRevmanRoomCount(pid, n);
      return { okKey: "revSaved" as const };
    }
    if (intent === "compAdd" || intent === "compUpdate") {
      const fields = {
        name: String(form.get("name") || ""),
        starClass: form.get("starClass"),
        reviewScore: form.get("reviewScore"),
        reviewCount: form.get("reviewCount"),
        bookingRef: String(form.get("bookingRef") || ""),
      };
      if (intent === "compAdd") await addCompetitor(pid, fields);
      else await updateCompetitor(pid, String(form.get("compId")), fields);
      return { okKey: "revSaved" as const };
    }
    if (intent === "compRemove") {
      await removeCompetitor(pid, String(form.get("compId")));
      return { okKey: "revSaved" as const };
    }
    if (intent === "compDiscover") {
      const area = String(form.get("area") || "").trim();
      // Exclude the owner's own hotel from the suggestions (name match).
      const selfName = (await getOverrides(pid)).hotelName || "";
      const result = await discoverCompetitors(area, { excludeName: selfName });
      if (!result.ok) return { error: result.error ?? "Search failed." };
      return { discover: { candidates: result.candidates, cost: result.cost, area } };
    }
    if (intent === "compAddBulk") {
      const picked = form.getAll("cand").map(String);
      let added = 0;
      for (const raw of picked) {
        try {
          const c = JSON.parse(raw) as CandidateHotel;
          if (c?.name) {
            await addCompetitor(pid, {
              name: c.name,
              starClass: c.starClass,
              reviewScore: c.reviewScore,
              reviewCount: c.reviewCount,
              bookingRef: c.bookingRef,
            });
            added++;
          }
        } catch {
          /* skip malformed row */
        }
      }
      return { okKey: "revCompAdded" as const, addedCount: added };
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

function Delta({ label, kpi }: { label: string; kpi: number | null }) {
  if (kpi === null) return <span className="text-faint">— {label}</span>;
  const up = kpi > 0;
  const flat = kpi === 0;
  return (
    <span className={flat ? "text-muted" : up ? "text-emerald-700" : "text-[#c0392b]"}>
      {flat ? "•" : up ? "▲" : "▼"} {Math.abs(kpi)}% {label}
    </span>
  );
}

function KpiTile({ label, value, kpi, t }: { label: string; value: string; kpi: Kpi; t: AdminT }) {
  return (
    <div className="rounded-[14px] border border-line bg-surface p-5">
      <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className="mt-1.5 font-serif text-[24px] font-semibold text-ink">{value}</div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11.5px]">
        <Delta label={t("revVsLastWeek")} kpi={kpi.wow} />
        <Delta label={t("revVsLastYear")} kpi={kpi.yoy} />
      </div>
    </div>
  );
}

const pctText = (v: number) => `${Math.round(v * 1000) / 10}%`;

const SCORE_STYLE: Record<SalesScore, string> = {
  sold_out: "bg-emerald-600 border-emerald-700 text-white",
  filling_up: "bg-teal-100 border-teal-200 text-teal-900",
  high_demand: "bg-emerald-100 border-emerald-200 text-emerald-900",
  steady_sales: "bg-sky-100 border-sky-200 text-sky-900",
  slow_sales: "bg-amber-100 border-amber-200 text-amber-900",
  needs_attention: "bg-rose-100 border-rose-200 text-rose-900",
};
const SCORE_DOT: Record<SalesScore, string> = {
  sold_out: "bg-emerald-600",
  filling_up: "bg-teal-400",
  high_demand: "bg-emerald-400",
  steady_sales: "bg-sky-400",
  slow_sales: "bg-amber-400",
  needs_attention: "bg-rose-400",
};
const SCORE_KEY: Record<SalesScore, string> = {
  sold_out: "revScoreSoldOut",
  filling_up: "revScoreFilling",
  high_demand: "revScoreHigh",
  steady_sales: "revScoreSteady",
  slow_sales: "revScoreSlow",
  needs_attention: "revScoreAttention",
};

const shiftMonth = (ym: string, by: number): string => {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

function PaceCalendar({
  days,
  month,
  today,
  roomCount,
}: {
  days: PaceDay[];
  month: string;
  today: string;
  roomCount: number;
}) {
  const t = useAdminT();
  const dl = useAdminDateLocale();
  const [selected, setSelected] = useState<PaceDay | null>(null);
  // Monday-first grid offset; 2026-07-20 is a Monday, used to label columns.
  const firstDow = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const mondayRef = "2026-07-20";
  const scores: SalesScore[] = [
    "sold_out",
    "filling_up",
    "high_demand",
    "steady_sales",
    "slow_sales",
    "needs_attention",
  ];

  return (
    <section className="mt-6 rounded-[14px] border border-line bg-surface p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-serif text-[18px] font-semibold">{t("revPaceTitle")}</div>
          <p className="mb-0 mt-1 max-w-[560px] text-[13px] text-muted">{t("revPaceSub")}</p>
        </div>
        <div className="flex items-center gap-1">
          <Link
            to={`/admin/revenue?month=${shiftMonth(month, -1)}`}
            preventScrollReset
            className="rounded-[8px] border border-line-alt px-2.5 py-1 text-[14px] text-secondary hover:bg-chip"
          >
            ←
          </Link>
          <span className="inline-block w-40 text-center text-[13.5px] font-semibold">
            {fmtDate(`${month}-01`, "LLLL yyyy", dl)}
          </span>
          <Link
            to={`/admin/revenue?month=${shiftMonth(month, 1)}`}
            preventScrollReset
            className="rounded-[8px] border border-line-alt px-2.5 py-1 text-[14px] text-secondary hover:bg-chip"
          >
            →
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-4">
        {scores.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5 text-[12px] text-secondary">
            <span className={`inline-block h-3 w-3 rounded-[4px] ${SCORE_DOT[s]}`} /> {t(SCORE_KEY[s])}
          </span>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1.5">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
            {fmtDate(new Date(Date.parse(`${mondayRef}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), "EEE", dl)}
          </div>
        ))}
        {Array.from({ length: firstDow }, (_, i) => (
          <div key={`o${i}`} />
        ))}
        {days.map((d) => {
          const offline = d.offline ?? 0;
          const totalPct =
            offline > 0 ? Math.round(((d.occupancy + offline) / Math.max(1, roomCount)) * 1000) / 10 : d.occupancyPct;
          return (
            <button
              key={d.date}
              type="button"
              onClick={() => setSelected(selected?.date === d.date ? null : d)}
              className={`min-h-[76px] rounded-[10px] border p-2 text-left ${SCORE_STYLE[d.score]} ${d.date < today ? "opacity-50" : ""} ${selected?.date === d.date ? "ring-2 ring-accent" : ""}`}
            >
              <div className="flex items-baseline justify-between text-[12.5px] font-semibold">
                <span>{Number(d.date.slice(8))}</span>
                <span>{totalPct}%</span>
              </div>
              <div className="mt-1.5 text-[11px] leading-tight opacity-80">
                {d.occupancy}
                {offline > 0 && <span className="opacity-70">+{offline}</span>}/{roomCount}
                <br />
                {d.salesAbs >= 0 ? `+${d.salesAbs}` : d.salesAbs} {t(d.vsTypical ? "revPaceVsTypical" : "revPaceVsLy")}
              </div>
            </button>
          );
        })}
      </div>
      {days.some((d) => (d.offline ?? 0) > 0) && (
        <p className="mb-0 mt-3 text-[12px] text-faint">{t("revPaceOfflineLegend")}</p>
      )}

      {selected && (
        <div className="mt-4 rounded-[12px] border border-line-alt bg-surface-alt p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[14px] font-semibold">
              {fmtDate(selected.date, "EEEE, d MMMM yyyy", dl)}
              <span
                className={`ml-2 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold ${SCORE_STYLE[selected.score]}`}
              >
                {t(SCORE_KEY[selected.score])}
              </span>
            </div>
            <button type="button" onClick={() => setSelected(null)} className="text-[13px] text-muted hover:text-ink">
              ✕
            </button>
          </div>
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{t("revPaceOnBooks")}</dt>
              <dd className="font-semibold">
                {selected.paceCur}{" "}
                {t(selected.vsTypical ? "revPaceVsTypicalLong" : "revPaceVsLyLong", {
                  count: String(selected.paceLy),
                })}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{t("revPacePickup")}</dt>
              <dd className="font-semibold">
                {selected.pickupCur}{" "}
                {t(selected.vsTypical ? "revPaceVsTypicalLong" : "revPaceVsLyLong", {
                  count: String(selected.pickupLy),
                })}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{t("revPaceOccupancy")}</dt>
              <dd className="font-semibold">
                {(selected.offline ?? 0) > 0 ? (
                  <>
                    {selected.occupancy} + {selected.offline} {t("revPaceOffline")} /{roomCount} (
                    {Math.round(((selected.occupancy + (selected.offline ?? 0)) / Math.max(1, roomCount)) * 1000) / 10}
                    %)
                  </>
                ) : (
                  <>
                    {selected.occupancy}/{roomCount} ({selected.occupancyPct}%)
                  </>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{t("revPaceDba")}</dt>
              <dd className="font-semibold">{selected.dba < 0 ? t("revPacePast") : selected.dba}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{t("revPaceWeights")}</dt>
              <dd className="font-semibold">
                {Math.round(selected.wPace * 100)}% / {Math.round(selected.wPickup * 100)}%
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{t("revPaceScore")}</dt>
              <dd className="font-semibold">{selected.scoreRaw}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}

/** Occupancy column chart with an optional dashed forecast tick per bar —
 *  hand-rolled like the analytics page. */
function OccupancyChart({
  days,
  roomCount,
  today,
  forecastLabel,
  offlineLabel,
}: {
  days: { date: string; nights: number; forecast?: number; offline?: number }[];
  roomCount: number;
  today: string;
  forecastLabel: string;
  offlineLabel: string;
}) {
  const dl = useAdminDateLocale();
  const cap = Math.max(1, roomCount);
  // date-fns "EEEEE" = narrow one-letter weekday, localized (M T W T F S S).
  const dayLetter = (iso: string) => fmtDate(iso, "EEEEE", dl);
  const isWeekend = (iso: string) => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
  return (
    <div>
      <div className="flex h-[160px] gap-[3px]">
        {days.map((d) => {
          const h = Math.min(1, d.nights / cap);
          const offline = d.offline ?? 0;
          const hTotal = Math.min(1, (d.nights + offline) / cap);
          const past = d.date < today;
          const fc = d.forecast === undefined ? undefined : Math.min(1, d.forecast / cap);
          return (
            <div key={d.date} className="group relative flex-1">
              {/* Inferred offline demand stacked under the online bar (lighter). */}
              {offline > 0 && !past && (
                <div
                  className="absolute bottom-0 w-full rounded-t-[3px] bg-accent/35"
                  style={{ height: `${Math.max(2, hTotal * 152)}px` }}
                />
              )}
              <div
                className={`absolute bottom-0 w-full rounded-t-[3px] ${past ? "bg-chip-border" : "bg-accent"} ${d.date === today ? "ring-2 ring-accent/40" : ""}`}
                style={{ height: `${Math.max(2, h * 152)}px` }}
              />
              {fc !== undefined && !past && (
                <div
                  className="absolute w-full border-t-2 border-dashed border-ink/50"
                  style={{ bottom: `${Math.max(2, fc * 152)}px` }}
                />
              )}
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-[8px] border border-line bg-surface px-2.5 py-1.5 text-[11.5px] text-secondary shadow-sm group-hover:block">
                <span className="font-semibold">{fmtDate(d.date, "EEE d MMM", dl)}</span> · {d.nights}/{cap} ·{" "}
                {pctText(d.nights / cap)}
                {offline > 0 && !past && (
                  <>
                    <br />
                    {offlineLabel}: {offline} · {pctText((d.nights + offline) / cap)}
                  </>
                )}
                {d.forecast !== undefined && !past && (
                  <>
                    <br />
                    {forecastLabel}: {d.forecast}/{cap} · {pctText(d.forecast / cap)}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* One-letter weekday axis; weekends emphasized, full date on hover. */}
      <div className="mt-1.5 flex gap-[3px]">
        {days.map((d) => (
          <div
            key={d.date}
            title={fmtDate(d.date, "EEEE, d MMMM yyyy", dl)}
            className={`flex-1 text-center text-[10px] leading-tight ${
              d.date === today
                ? "font-bold text-accent"
                : isWeekend(d.date)
                  ? "font-semibold text-secondary"
                  : "text-faint"
            }`}
          >
            {dayLetter(d.date)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Manual competitor set with quality ranking. Each row (including our own
 *  hotel) is an inline edit form; a new-competitor form sits at the bottom. */
function CompSet({
  view,
  busy,
  t,
  scrapflyOn,
  area,
  discover,
}: {
  view: CompSetView;
  busy: boolean;
  t: AdminT;
  scrapflyOn: boolean;
  area: string;
  discover?: { candidates: CandidateHotel[]; cost: number | null; area: string };
}) {
  const numCls = "w-full rounded-[7px] border border-line-alt bg-surface px-2 py-1 text-[13px]";
  const stars = [1, 2, 3, 4, 5];
  return (
    <section className="mt-6 rounded-[14px] border border-line bg-surface p-6">
      <div className="font-serif text-[18px] font-semibold">{t("revCompTitle")}</div>
      <p className="mb-4 mt-1 max-w-[640px] text-[13px] text-muted">{t("revCompSub")}</p>

      <div
        className={`mb-4 rounded-[10px] border px-4 py-3 text-[13.5px] ${
          view.standing.position !== null
            ? "border-accent/30 bg-accent/5 text-secondary"
            : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        {view.standing.position !== null
          ? t("revCompStanding", { pos: String(view.standing.position), of: String(view.standing.rated) })
          : t("revCompStandingUnrated")}
      </div>

      {/* Discovery: find nearby hotels on Booking.com, review, then add. */}
      {scrapflyOn ? (
        <div className="mb-5 rounded-[12px] border border-dashed border-line-alt bg-chip/40 p-4">
          <div className="text-[13px] font-semibold text-secondary">{t("revCompFindTitle")}</div>
          <p className="mb-2 mt-0.5 text-[12.5px] text-muted">{t("revCompFindSub")}</p>
          <Form method="post" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="intent" value="compDiscover" />
            <label className="text-[12px] text-muted">
              {t("revCompArea")}
              <input
                name="area"
                defaultValue={discover?.area ?? area}
                placeholder={t("revCompAreaPlaceholder")}
                className={`${numCls} mt-0.5 w-72`}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded-[9px] bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
            >
              {t("revCompFind")}
            </button>
          </Form>

          {discover && (
            <div className="mt-4">
              {discover.candidates.length === 0 ? (
                <p className="text-[13px] text-muted">{t("revCompFindNone")}</p>
              ) : (
                <Form method="post">
                  <input type="hidden" name="intent" value="compAddBulk" />
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[12.5px] text-muted">
                      {t("revCompFound", { n: String(discover.candidates.length) })}
                    </span>
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-[9px] bg-accent px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-60"
                    >
                      {t("revCompAddSelected")}
                    </button>
                  </div>
                  <div className="max-h-[320px] space-y-1 overflow-y-auto rounded-[8px] border border-line-alt bg-surface p-1.5">
                    {discover.candidates.map((c, i) => (
                      <label
                        key={`${c.bookingRef}-${i}`}
                        className="grid grid-cols-[1.5rem_1fr_3rem_3.5rem_5rem_4rem] items-center gap-2 rounded-[7px] px-2 py-1 text-[13px] hover:bg-chip"
                      >
                        <input
                          type="checkbox"
                          name="cand"
                          value={JSON.stringify(c)}
                          defaultChecked={Boolean(c.starClass)}
                          className="justify-self-center"
                        />
                        <span className="min-w-0 truncate" title={c.name}>
                          {c.name}
                        </span>
                        <span className="text-muted">{c.starClass ? `${c.starClass}★` : "—"}</span>
                        <span className="font-semibold tabular-nums">{c.reviewScore ?? "—"}</span>
                        <span className="text-muted tabular-nums">
                          {c.reviewCount ? c.reviewCount.toLocaleString() : "—"}
                        </span>
                        <span className="text-right text-muted tabular-nums">{c.priceText ?? ""}</span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11.5px] text-muted">{t("revCompFindHint")}</p>
                </Form>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mb-5 rounded-[12px] border border-dashed border-line-alt bg-chip/40 p-4 text-[12.5px] text-muted">
          {t("revCompScrapeOff")}
        </div>
      )}

      {/* Header row */}
      <div className="grid grid-cols-[2rem_1fr_5rem_5rem_6rem_3.5rem_5.5rem] items-center gap-2 px-1 pb-1 text-[11px] uppercase tracking-[0.05em] text-muted">
        <span>#</span>
        <span>{t("revCompColName")}</span>
        <span>{t("revCompColStar")}</span>
        <span>{t("revCompColScore")}</span>
        <span>{t("revCompColReviews")}</span>
        <span className="text-right">{t("revCompColQuality")}</span>
        <span />
      </div>

      <div className="space-y-1.5">
        {view.ranked.map((h) => (
          <Form
            method="post"
            key={h.id}
            className={`grid grid-cols-[2rem_1fr_5rem_5rem_6rem_3.5rem_5.5rem] items-center gap-2 rounded-[10px] border px-1.5 py-1.5 ${
              h.isSelf ? "border-accent/40 bg-accent/5" : "border-line-alt"
            }`}
          >
            <input type="hidden" name="intent" value="compUpdate" />
            <input type="hidden" name="compId" value={h.id} />
            <span className="pl-1 text-[13px] font-semibold tabular-nums text-secondary">{h.rank ?? "—"}</span>
            <span className="min-w-0">
              <input name="name" defaultValue={h.name} className={numCls} />
              {h.isSelf && (
                <span className="ml-0.5 mt-0.5 inline-block text-[11px] font-semibold text-accent">
                  {t("revCompYou")}
                </span>
              )}
            </span>
            <select name="starClass" defaultValue={h.starClass ?? ""} className={numCls}>
              <option value="">—</option>
              {stars.map((s) => (
                <option key={s} value={s}>
                  {s}★
                </option>
              ))}
            </select>
            <input
              name="reviewScore"
              type="number"
              min={0}
              max={10}
              step="0.1"
              defaultValue={h.reviewScore ?? ""}
              placeholder="/10"
              className={numCls}
            />
            <input
              name="reviewCount"
              type="number"
              min={0}
              step="1"
              defaultValue={h.reviewCount ?? ""}
              placeholder="#"
              className={numCls}
            />
            <span className="text-right text-[14px] font-semibold tabular-nums">{h.qualityIndex ?? "—"}</span>
            <span className="flex justify-end gap-1">
              <button
                type="submit"
                disabled={busy}
                className="rounded-[7px] border border-line-alt px-2 py-1 text-[12px] font-semibold text-secondary hover:bg-chip disabled:opacity-50"
              >
                {t("revCompSave")}
              </button>
              {!h.isSelf && (
                <button
                  type="submit"
                  name="intent"
                  value="compRemove"
                  disabled={busy}
                  title={t("revCompRemove")}
                  className="rounded-[7px] border border-line-alt px-2 py-1 text-[12px] text-muted hover:bg-chip disabled:opacity-50"
                >
                  ✕
                </button>
              )}
            </span>
          </Form>
        ))}
      </div>

      {/* Add competitor */}
      <Form method="post" className="mt-4 border-t border-line-alt pt-4">
        <input type="hidden" name="intent" value="compAdd" />
        <div className="text-[13px] font-semibold text-secondary">{t("revCompAddTitle")}</div>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-[12px] text-muted">
            {t("revCompColName")}
            <input name="name" required className={`${numCls} mt-0.5 w-48`} />
          </label>
          <label className="text-[12px] text-muted">
            {t("revCompColStar")}
            <select name="starClass" defaultValue="" className={`${numCls} mt-0.5 w-20`}>
              <option value="">—</option>
              {stars.map((s) => (
                <option key={s} value={s}>
                  {s}★
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] text-muted">
            {t("revCompColScore")}
            <input name="reviewScore" type="number" min={0} max={10} step="0.1" className={`${numCls} mt-0.5 w-20`} />
          </label>
          <label className="text-[12px] text-muted">
            {t("revCompColReviews")}
            <input name="reviewCount" type="number" min={0} step="1" className={`${numCls} mt-0.5 w-24`} />
          </label>
          <label className="text-[12px] text-muted">
            {t("revCompColBooking")}
            <input name="bookingRef" placeholder="booking.com/…" className={`${numCls} mt-0.5 w-56`} />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-[9px] bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
          >
            {t("revCompAdd")}
          </button>
        </div>
      </Form>
    </section>
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

  const { state, summary, kpis, paceDays, paceMonth, forecast, suggestions, compSet } = loaderData;
  const forecastByDate = new Map((forecast ?? []).map((f) => [f.date, f]));
  const ready = state ? guardsReady(state) : false;
  const importing = state?.importStatus === "running" && !loaderData.stalled;

  // While an import runs in the background, re-fetch every few seconds so the
  // progress line and (eventually) the dashboard fill in without a manual reload.
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!importing) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 4000);
    return () => clearInterval(id);
  }, [importing, revalidator]);
  const pick = actionData && "pick" in actionData && actionData.pick ? { pick: actionData.pick, apiKey: actionData.apiKey } : undefined;
  const money = (minor: number, currency?: string) => formatMoney(minor / 100, currency ?? "EUR");

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
          {actionData.okKey === "revSugApplied" && "applied" in actionData && actionData.applied
            ? t("revSugApplied", {
                dates: String(actionData.applied.dates),
                cells: String(actionData.applied.cells),
              })
            : actionData.okKey === "revCompAdded" && "addedCount" in actionData
              ? t("revCompAdded", { n: String(actionData.addedCount) })
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
          {importing && (
            <div className="mb-4 flex items-center gap-3 rounded-[10px] border border-line-alt bg-surface px-4 py-3 text-[13.5px] text-secondary">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              {t("revImportProgress", { count: String(state.progressCount ?? 0) })}
            </div>
          )}
          {loaderData.stalled && (
            <p className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13.5px] text-amber-800">
              {t("revImportStalled")}
            </p>
          )}
          {kpis ? (
            <>
              <h2 className="mb-2 font-serif text-[18px] font-semibold">{t("revTodayTitle")}</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <KpiTile label={t("revKpiOccupancy")} value={pctText(kpis.today.occupancy.value)} kpi={kpis.today.occupancy} t={t} />
                <KpiTile label={t("revKpiAdr")} value={money(kpis.today.adrMinor.value, kpis.currency)} kpi={kpis.today.adrMinor} t={t} />
                <KpiTile label={t("revKpiRevenue")} value={money(kpis.today.revenueMinor.value, kpis.currency)} kpi={kpis.today.revenueMinor} t={t} />
              </div>

              <h2 className="mb-2 mt-6 font-serif text-[18px] font-semibold">{t("revMonthTitle")}</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <KpiTile label={t("revKpiRevenue")} value={money(kpis.month.revenueMinor.value, kpis.currency)} kpi={kpis.month.revenueMinor} t={t} />
                <KpiTile label={t("revKpiOccupancy")} value={pctText(kpis.month.occupancy.value)} kpi={kpis.month.occupancy} t={t} />
                <KpiTile label={t("revKpiAdr")} value={money(kpis.month.adrMinor.value, kpis.currency)} kpi={kpis.month.adrMinor} t={t} />
                <KpiTile label={t("revKpiRevpar")} value={money(kpis.month.revparMinor.value, kpis.currency)} kpi={kpis.month.revparMinor} t={t} />
                <KpiTile label={t("revKpiRoomNights")} value={String(kpis.month.roomNights.value)} kpi={kpis.month.roomNights} t={t} />
                <KpiTile
                  label={t("revKpiAvgLos")}
                  value={t("revNightsValue", { count: String(Math.round(kpis.month.avgLos.value * 10) / 10) })}
                  kpi={kpis.month.avgLos}
                  t={t}
                />
              </div>

              <section className="mt-6 rounded-[14px] border border-line bg-surface p-6">
                <div className="font-serif text-[18px] font-semibold">{t("revOccChartTitle")}</div>
                <p className="mb-4 mt-1 text-[13px] text-muted">
                  {t("revOccChartSub", { count: String(state.roomCount) })} {forecast && t("revForecastLegend")}
                </p>
                <OccupancyChart
                  days={(() => {
                    const byDate = new Map(kpis.monthOccupancy.map((r) => [r.date, r.nights]));
                    const monthFrom = `${loaderData.today.slice(0, 8)}01`;
                    const out: { date: string; nights: number; forecast?: number; offline?: number }[] = [];
                    for (let i = 0; i < 31; i++) {
                      const iso = new Date(Date.parse(`${monthFrom}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
                      if (iso.slice(0, 7) !== loaderData.today.slice(0, 7)) break;
                      out.push({
                        date: iso,
                        nights: byDate.get(iso) ?? 0,
                        forecast: forecastByDate.get(iso)?.forecast,
                        offline: forecastByDate.get(iso)?.offlineOnBooks,
                      });
                    }
                    return out;
                  })()}
                  roomCount={state.roomCount}
                  today={loaderData.today}
                  forecastLabel={t("revForecast")}
                  offlineLabel={t("revOffline")}
                />
              </section>

              {forecast && (
                <section className="mt-6 rounded-[14px] border border-line bg-surface p-6">
                  <div className="font-serif text-[18px] font-semibold">{t("revForecastTitle")}</div>
                  <p className="mb-4 mt-1 max-w-[620px] text-[13px] text-muted">{t("revForecastSub")}</p>
                  <OccupancyChart
                    days={forecast
                      .filter((f) => f.date >= loaderData.today)
                      .map((f) => ({ date: f.date, nights: f.onBooks, forecast: f.forecast, offline: f.offlineOnBooks }))}
                    roomCount={state.roomCount}
                    today={loaderData.today}
                    forecastLabel={t("revForecast")}
                    offlineLabel={t("revOffline")}
                  />
                  {forecast.some((f) => f.offlineOnBooks > 0) && (
                    <p className="mb-0 mt-3 text-[12px] text-faint">{t("revOfflineLegend")}</p>
                  )}
                </section>
              )}

              {paceDays && (
                <PaceCalendar days={paceDays} month={paceMonth} today={loaderData.today} roomCount={state.roomCount} />
              )}

              {suggestions && (
                <section className="mt-6 rounded-[14px] border border-line bg-surface p-6">
                  <div className="font-serif text-[18px] font-semibold">{t("revSugTitle")}</div>
                  <p className="mb-4 mt-1 max-w-[620px] text-[13px] text-muted">{t("revSugSub")}</p>

                  <Form method="post" className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="intent" value="priceGuards" />
                    <label className="block text-[13px] font-semibold text-secondary">
                      {t("revSugGuardMin")}
                      <input
                        name="minPrice"
                        type="number"
                        min={1}
                        step="1"
                        defaultValue={state.minPrice}
                        className={`${FIELD_INPUT} w-28`}
                      />
                    </label>
                    <label className="block text-[13px] font-semibold text-secondary">
                      {t("revSugGuardMax")}
                      <input
                        name="maxPrice"
                        type="number"
                        min={1}
                        step="1"
                        defaultValue={state.maxPrice}
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
                    {!ready && <span className="pb-3 text-[12.5px] text-amber-700">{t("revSugGuardsHint")}</span>}
                  </Form>

                  <div className="mt-4 max-h-[430px] overflow-y-auto rounded-[10px] border border-line-alt">
                    <table className="w-full text-[13px]">
                      <thead className="sticky top-0 bg-surface-alt text-left text-[11.5px] uppercase tracking-[0.06em] text-muted">
                        <tr>
                          <th className="px-3 py-2 font-semibold">{t("revSugColDate")}</th>
                          <th className="px-3 py-2 font-semibold">{t("revSugColPace")}</th>
                          <th className="px-3 py-2 font-semibold">{t("revSugColForecast")}</th>
                          <th className="px-3 py-2 font-semibold">{t("revSugColCurrent")}</th>
                          <th className="px-3 py-2 font-semibold">{t("revSugColSuggested")}</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {suggestions.map((s) => {
                          const atTarget = s.target !== undefined && s.target === s.fromPrice;
                          const actionable =
                            s.pct !== 0 && s.fromPrice !== undefined && (!ready || !atTarget);
                          return (
                            <tr key={s.date} className="border-t border-line-alt">
                              <td className="whitespace-nowrap px-3 py-2 font-semibold">{fmtDate(s.date, "EEE d MMM", dl)}</td>
                              <td className="px-3 py-2">
                                <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]">
                                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${SCORE_DOT[s.score]}`} />
                                  {t(SCORE_KEY[s.score])}
                                </span>
                              </td>
                              <td className="px-3 py-2">{pctText(s.forecastPercent)}</td>
                              <td className="px-3 py-2">{s.fromPrice !== undefined ? money(s.fromPrice * 100, kpis?.currency) : "—"}</td>
                              <td className="whitespace-nowrap px-3 py-2">
                                {s.pct === 0 || s.fromPrice === undefined ? (
                                  <span className="text-muted">{t("revSugHold")}</span>
                                ) : atTarget ? (
                                  <span className="text-muted">✓ {t("revSugAtTarget")}</span>
                                ) : (
                                  <>
                                    {ready && s.target !== undefined && (
                                      <span className="mr-2 font-semibold">{money(s.target * 100, kpis?.currency)}</span>
                                    )}
                                    <span
                                      className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${s.pct > 0 ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}
                                    >
                                      {s.pct > 0 ? `+${s.pct}%` : `${s.pct}%`}
                                    </span>
                                  </>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {actionable && (
                                  <Form method="post" className="inline">
                                    <input type="hidden" name="intent" value="applyPrice" />
                                    <input type="hidden" name="date" value={s.date} />
                                    <button
                                      type="submit"
                                      disabled={busy || !ready}
                                      title={ready ? undefined : t("revSugGuardsHint")}
                                      className="rounded-[8px] border border-line-alt px-2.5 py-1 text-[12px] font-semibold text-secondary hover:bg-chip disabled:opacity-50"
                                    >
                                      {t("revSugApply")}
                                    </button>
                                  </Form>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-[12.5px] text-faint">
                      {t("revSugCount", {
                        count: String(
                          suggestions.filter(
                            (s) => s.pct !== 0 && s.fromPrice !== undefined && (s.target === undefined || s.target !== s.fromPrice),
                          ).length,
                        ),
                      })}
                    </span>
                    <Form method="post">
                      <input type="hidden" name="intent" value="applyPriceAll" />
                      <button
                        type="submit"
                        disabled={
                          busy ||
                          !ready ||
                          suggestions.every(
                            (s) => s.pct === 0 || s.fromPrice === undefined || s.target === s.fromPrice,
                          )
                        }
                        className="rounded-[10px] bg-accent px-4 py-2 text-[13.5px] font-semibold text-white disabled:opacity-60"
                      >
                        {busyIntent === "applyPriceAll" ? t("revSugApplying") : t("revSugApplyAll")}
                      </button>
                    </Form>
                  </div>
                </section>
              )}
            </>
          ) : (
            <section className="rounded-[14px] border border-line bg-surface p-6">
              <p className="text-[13.5px] text-muted">{t("revNoDataYet")}</p>
            </section>
          )}

          {compSet && (
            <CompSet
              view={compSet}
              busy={busy}
              t={t}
              scrapflyOn={loaderData.scrapflyOn}
              area={loaderData.compArea}
              discover={actionData && "discover" in actionData ? actionData.discover : undefined}
            />
          )}

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
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-muted">{t("revImportedLabel")}</dt>
                <dd className="font-semibold text-ink">
                  {t("revImportedSummary", {
                    nights: String(summary?.nights ?? 0),
                    bookings: String(summary?.bookings ?? 0),
                    cancelled: String(summary?.cancelledBookings ?? 0),
                  })}
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
                  disabled={busy || importing}
                  className="rounded-[10px] bg-accent px-4 py-2 text-[13.5px] font-semibold text-white disabled:opacity-60"
                >
                  {busyIntent === "refresh" || importing ? t("revImporting") : t("revRefreshCta")}
                </button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="refreshFull" />
                <button
                  type="submit"
                  disabled={busy || importing}
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
