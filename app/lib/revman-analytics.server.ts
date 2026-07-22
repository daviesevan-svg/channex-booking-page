// Revenue-management analytics: SQL aggregations over the rev_night table.
// KPI semantics follow the RevPanda reference: cancelled bookings excluded,
// every metric returned with week-over-week and year-over-year deltas. YoY is
// 364 days back (52 whole weeks) so weekdays stay aligned.
import { getDB } from "./config.server";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

export interface Kpi {
  value: number;
  /** Percent change vs the same range 7 days earlier; null when no base. */
  wow: number | null;
  /** Percent change vs the same range 364 days earlier; null when no base. */
  yoy: number | null;
}

export interface KpiSet {
  adrMinor: Kpi;
  revenueMinor: Kpi;
  /** 0..1 (can exceed 1 if roomCount is set too low). */
  occupancy: Kpi;
  revparMinor: Kpi;
  roomNights: Kpi;
  avgLos: Kpi;
}

export interface RevmanKpis {
  today: KpiSet;
  month: KpiSet;
  /** Active room-nights per date for the current month (chart). */
  monthOccupancy: { date: string; nights: number }[];
  currency?: string;
}

interface RangeAgg {
  nights: number;
  revenueMinor: number;
  adrMinor: number;
  avgLos: number;
}

const shiftISO = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const rangeDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

function aggStmt(pid: string, from: string, to: string) {
  return db()
    .prepare(
      `SELECT COUNT(*) AS nights,
              COALESCE(SUM(rate_minor), 0) AS revenue,
              COALESCE(AVG(rate_minor), 0) AS adr,
              COALESCE(AVG(los), 0) AS avg_los
       FROM rev_night
       WHERE pid = ? AND is_cancelled = 0 AND stay_date >= ? AND stay_date <= ?`,
    )
    .bind(pid, from, to);
}

const toAgg = (row: Record<string, unknown> | undefined): RangeAgg => ({
  nights: Number(row?.nights ?? 0),
  revenueMinor: Number(row?.revenue ?? 0),
  adrMinor: Number(row?.adr ?? 0),
  avgLos: Number(row?.avg_los ?? 0),
});

const pct = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;

function kpiSet(cur: RangeAgg, wow: RangeAgg, yoy: RangeAgg, roomCount: number, days: number): KpiSet {
  const capacity = Math.max(1, roomCount) * Math.max(1, days);
  const occ = (a: RangeAgg) => a.nights / capacity;
  const revpar = (a: RangeAgg) => a.revenueMinor / capacity;
  const kpi = (f: (a: RangeAgg) => number): Kpi => ({
    value: f(cur),
    wow: pct(f(cur), f(wow)),
    yoy: pct(f(cur), f(yoy)),
  });
  return {
    adrMinor: kpi((a) => a.adrMinor),
    revenueMinor: kpi((a) => a.revenueMinor),
    occupancy: kpi(occ),
    revparMinor: kpi(revpar),
    roomNights: kpi((a) => a.nights),
    avgLos: kpi((a) => a.avgLos),
  };
}

/** Today + current-month KPIs (each with WoW/YoY deltas) and the month's
 *  per-date occupancy for the chart. `todayISO` is the property's "today"
 *  (caller decides the timezone). */
export async function getRevmanKpis(pid: string, todayISO: string, roomCount: number): Promise<RevmanKpis> {
  const monthFrom = `${todayISO.slice(0, 8)}01`;
  const monthToDate = new Date(Date.UTC(Number(todayISO.slice(0, 4)), Number(todayISO.slice(5, 7)), 0));
  const monthTo = monthToDate.toISOString().slice(0, 10);

  const [tCur, tWow, tYoy, mCur, mWow, mYoy, perDate, cur] = await db().batch([
    aggStmt(pid, todayISO, todayISO),
    aggStmt(pid, shiftISO(todayISO, -7), shiftISO(todayISO, -7)),
    aggStmt(pid, shiftISO(todayISO, -364), shiftISO(todayISO, -364)),
    aggStmt(pid, monthFrom, monthTo),
    aggStmt(pid, shiftISO(monthFrom, -7), shiftISO(monthTo, -7)),
    aggStmt(pid, shiftISO(monthFrom, -364), shiftISO(monthTo, -364)),
    db()
      .prepare(
        `SELECT stay_date AS date, COUNT(*) AS nights
         FROM rev_night
         WHERE pid = ? AND is_cancelled = 0 AND stay_date >= ? AND stay_date <= ?
         GROUP BY stay_date ORDER BY stay_date`,
      )
      .bind(pid, monthFrom, monthTo),
    db()
      .prepare(
        `SELECT currency, COUNT(*) AS n FROM rev_night
         WHERE pid = ? AND currency IS NOT NULL GROUP BY currency ORDER BY n DESC LIMIT 1`,
      )
      .bind(pid),
  ]);

  return {
    today: kpiSet(
      toAgg(tCur.results[0] as Record<string, unknown>),
      toAgg(tWow.results[0] as Record<string, unknown>),
      toAgg(tYoy.results[0] as Record<string, unknown>),
      roomCount,
      1,
    ),
    month: kpiSet(
      toAgg(mCur.results[0] as Record<string, unknown>),
      toAgg(mWow.results[0] as Record<string, unknown>),
      toAgg(mYoy.results[0] as Record<string, unknown>),
      roomCount,
      rangeDays(monthFrom, monthTo),
    ),
    monthOccupancy: (perDate.results as { date: string; nights: number }[]).map((r) => ({
      date: r.date,
      nights: Number(r.nights),
    })),
    currency: (cur.results[0] as { currency?: string } | undefined)?.currency ?? undefined,
  };
}
