import { useEffect } from "react";
import { Link, useNavigation, useRevalidator, useSearchParams } from "react-router";

import type { Route } from "./+types/rate-intel";
import { FeatureUnavailable } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { getRevmanState } from "~/lib/revman.server";
import { getCompSet } from "~/lib/revman-compset.server";
import {
  enqueueCaptureJob,
  getCaptureJob,
  getCaptureSettings,
  getCompPrices,
  lastCapturedAt,
  nudgeCaptureJob,
} from "~/lib/revman-comp-capture.server";
import { getRoomPrices } from "~/lib/revman-room-prices.server";
import { getCompareSettings } from "~/lib/direct-compare.server";
import { getBalance } from "~/lib/revman-tokens.server";
import { isScrapflyConfigured } from "~/lib/scrapfly.server";
import { formatMoney } from "~/lib/money";
import { fmtDate, todayISODate } from "~/lib/dates";
import { useAdminDateLocale, useAdminT } from "~/lib/admin-i18n";

const DAY = 86_400_000;
const isoAt = (base: string, add: number) =>
  new Date(Date.parse(`${base}T00:00:00Z`) + add * DAY).toISOString().slice(0, 10);

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { configured: false as const };
  // Rate intelligence is part of revenue management, which single-unit rentals
  // don't get (see /admin/revenue guard). Hidden in nav; this guards the URL.
  if ((await getSettings(pid)).singleUnit === true) return { configured: true as const, singleUnit: true as const };
  const state = await getRevmanState(pid);
  if (!state) return { configured: true as const, singleUnit: false as const, connected: false as const };

  const [set, settings, balance, propSettings, lastCap, job, compare] = await Promise.all([
    getCompSet(pid),
    getCaptureSettings(pid),
    getBalance(pid),
    getSettings(pid),
    lastCapturedAt(pid),
    getCaptureJob(pid),
    getCompareSettings(pid),
  ]);
  // Drive-by: while a capture job is running, each page load nudges the next
  // chunk (backup to the signed self-fetch chain).
  if (job?.status === "running") nudgeCaptureJob(pid);

  const today = todayISODate();
  const horizon = settings.horizonDays;
  const to = isoAt(today, horizon - 1);
  const rows = await getCompPrices(pid, today, to);

  // Room-level prices for one hotel at a time — the whole set at once would be a
  // grid of ~100 rows. Defaults to our own hotel, which is the one an owner
  // checks against their direct rates.
  const selfId = set.ranked.find((h) => h.isSelf)?.id;
  const wanted = new URL(request.url).searchParams.get("rooms");
  const roomsFor = set.ranked.some((h) => h.id === wanted) ? (wanted as string) : selfId;
  const roomRows = roomsFor ? await getRoomPrices(pid, roomsFor, today, to) : [];

  const dates = Array.from({ length: horizon }, (_, i) => isoAt(today, i));
  // cells[compId][date] = {minor, currency}
  const cells: Record<string, Record<string, { minor: number | null; currency: string | null }>> = {};
  for (const r of rows) {
    (cells[r.compId] ??= {})[r.date] = { minor: r.priceMinor, currency: r.currency };
  }
  const datesWithData = new Set(rows.filter((r) => r.priceMinor != null).map((r) => r.date)).size;

  // One row per room type, keeping the newest name we saw for it.
  const roomNames = new Map<string, { name: string; maxPersons: number | null }>();
  const roomCells: Record<string, Record<string, RoomCell>> = {};
  for (const r of roomRows) {
    roomNames.set(r.roomRef, { name: r.roomName, maxPersons: r.maxPersons });
    (roomCells[r.roomRef] ??= {})[r.date] = {
      minor: r.priceMinor,
      currency: r.currency,
      mealPlan: r.mealPlan,
      flexMinor: r.flexPriceMinor,
      genius: r.genius,
    };
  }

  return {
    configured: true as const,
    singleUnit: false as const,
    connected: true as const,
    scrapflyOn: isScrapflyConfigured(),
    hotels: set.ranked.map((h) => ({ id: h.id, name: h.name, isSelf: h.isSelf, rank: h.rank })),
    dates,
    cells,
    currency: propSettings.currency || "GBP",
    balance,
    horizon,
    datesWithData,
    lastCap,
    settingsEnabled: settings.enabled,
    // Status of the guest-facing "cheaper direct" badge, so this page shows
    // whether it's live instead of leaving it buried a click away.
    compare: {
      enabled: compare.enabled,
      mapped: Object.keys(compare.roomMap).length,
    },
    job,
    roomsFor: roomsFor ?? null,
    rooms: [...roomNames].map(([roomRef, v]) => ({ roomRef, ...v })),
    roomCells,
  };
}

interface RoomCell {
  minor: number;
  currency: string | null;
  mealPlan: string | null;
  flexMinor: number | null;
  genius: boolean;
}

export function meta() {
  return [{ title: "Admin · Rate intelligence" }];
}

export async function action({ request }: Route.ActionArgs) {
  const email = await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { error: "Select a property first." };
  const form = await request.formData();
  if (String(form.get("intent")) === "captureNow") {
    if ((await getBalance(pid)) < 1) return { errorKey: "riNoTokens" as const };
    // Optional explicit date range — lets the owner pull a chosen window (e.g.
    // a future season) instead of the default horizon from today.
    const from = String(form.get("from") || "").trim();
    const to = String(form.get("to") || "").trim();
    const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if ((from || to) && !(isIso(from) && isIso(to))) return { errorKey: "riBadRange" as const };
    if (isIso(from) && isIso(to) && to < from) return { errorKey: "riBadRange" as const };
    // Default to the settings horizon when no explicit range is given.
    const settings = await getCaptureSettings(pid);
    const today = todayISODate();
    const rangeFrom = isIso(from) ? from : today;
    const rangeTo = isIso(to) ? to : isoAt(today, settings.horizonDays - 1);
    // Resumable job: chunks hop across invocations (self-fetch chain + this
    // page's poll), so a week/month completes past the Worker time cap.
    const res = await enqueueCaptureJob(pid, rangeFrom, rangeTo, email);
    if (!res.ok) return { error: res.error ?? "Could not start capture." };
    return { okKey: "riCaptureStarted" as const };
  }
  return null;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function RateIntel({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const dl = useAdminDateLocale();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [, setSearchParams] = useSearchParams();

  if (!loaderData.configured) {
    return (
      <div>
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("riTitle")}</h1>
        <p className="text-[14px] text-muted">
          {t("anSelectPropertyPrefix")}{" "}
          <Link to="/admin/select-property" className="text-accent underline">{t("anSelectPropertyLink")}</Link>.
        </p>
      </div>
    );
  }
  if (loaderData.singleUnit) return <FeatureUnavailable title={t("revSingleUnitTitle")} body={t("revSingleUnitBody")} />;
  if (!loaderData.connected) {
    return (
      <div>
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("riTitle")}</h1>
        <p className="text-[14px] text-muted">
          {t("riConnectPrefix")}{" "}
          <Link to="/admin/revenue" className="text-accent underline">{t("navRevenue")}</Link>.
        </p>
      </div>
    );
  }

  const { hotels, dates, cells, currency, balance, horizon, datesWithData, lastCap, scrapflyOn, job, compare } = loaderData;

  // Poll while a capture job is running: revalidate every 4s so the table +
  // progress fill in live, and each load nudges the next chunk (loader).
  const revalidator = useRevalidator();
  const jobRunning = job?.status === "running";
  useEffect(() => {
    if (!jobRunning) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 4000);
    return () => clearInterval(id);
  }, [jobRunning, revalidator]);
  const money = (minor: number | null | undefined, cur: string | null) =>
    minor == null ? "—" : formatMoney(minor / 100, cur || currency);

  // cheapest price per date (across all hotels) for row highlighting
  const cheapestByDate: Record<string, number> = {};
  for (const d of dates) {
    let min = Infinity;
    for (const h of hotels) {
      const c = cells[h.id]?.[d];
      if (c?.minor != null && c.minor < min) min = c.minor;
    }
    if (min < Infinity) cheapestByDate[d] = min;
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold">{t("riTitle")}</h1>
          <p className="mt-1 text-[13.5px] text-muted">{t("riSubtitle")}</p>
        </div>
        <div className="flex items-end gap-4">
          {/* Kept clear of the date inputs: sitting inside that group made this
              navigation look like another filter control, and it got missed. */}
          <Link
            to="/admin/rate-intel/settings"
            className="flex items-center gap-1.5 py-2 text-[13px] font-semibold text-accent hover:underline"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M8.34 2.51a1.5 1.5 0 0 1 3.32 0l.16.72c.1.44.44.78.87.9.43.13.9.02 1.23-.29l.55-.5a1.5 1.5 0 0 1 2.35 1.9l-.38.64c-.23.39-.24.87-.02 1.26.22.4.63.65 1.08.67l.74.03a1.5 1.5 0 0 1 .58 2.88l-.68.29c-.41.18-.7.56-.76 1-.06.45.11.89.46 1.18l.57.48a1.5 1.5 0 0 1-1.66 2.45l-.7-.26a1.28 1.28 0 0 0-1.24.2c-.35.28-.53.72-.48 1.17l.09.73a1.5 1.5 0 0 1-2.79 1.02l-.38-.63a1.28 1.28 0 0 0-1.1-.62c-.45 0-.87.23-1.1.62l-.39.63a1.5 1.5 0 0 1-2.78-1.02l.08-.73a1.28 1.28 0 0 0-.47-1.17 1.28 1.28 0 0 0-1.25-.2l-.69.26a1.5 1.5 0 0 1-1.67-2.45l.57-.48c.35-.29.52-.73.46-1.18a1.28 1.28 0 0 0-.75-1l-.69-.29a1.5 1.5 0 0 1 .58-2.88l.75-.03c.45-.02.85-.27 1.07-.67.23-.39.22-.87-.01-1.26l-.38-.64a1.5 1.5 0 0 1 2.34-1.9l.55.5c.34.31.8.42 1.24.3.43-.13.76-.47.86-.91l.16-.72ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                clipRule="evenodd"
              />
            </svg>
            {t("riSettings")}
          </Link>
          <form method="post" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="intent" value="captureNow" />
            <label className="text-[11px] font-medium text-muted">
              {t("riFrom")}
              <input type="date" name="from" defaultValue={dates[0]} className="mt-0.5 block rounded-[8px] border border-line-alt bg-surface px-2 py-1.5 text-[13px]" />
            </label>
            <label className="text-[11px] font-medium text-muted">
              {t("riTo")}
              <input type="date" name="to" defaultValue={dates[dates.length - 1]} className="mt-0.5 block rounded-[8px] border border-line-alt bg-surface px-2 py-1.5 text-[13px]" />
            </label>
            <button
              type="submit"
              disabled={busy || jobRunning || !scrapflyOn || balance < 1}
              className="rounded-[10px] bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            >
              {jobRunning || (busy && nav.formData?.get("intent") === "captureNow") ? t("riCapturing") : t("riUpdateNow")}
            </button>
          </form>
        </div>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-800">{actionData.error}</p>
      )}
      {actionData && "errorKey" in actionData && actionData.errorKey && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-800">{t(actionData.errorKey)}</p>
      )}
      {actionData && "okKey" in actionData && actionData.okKey && (
        <p className="mb-4 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-800">{t(actionData.okKey)}</p>
      )}

      {jobRunning && job && (
        <div className="mb-4 rounded-[12px] border border-accent/30 bg-accent/5 px-4 py-3">
          <div className="flex items-center justify-between text-[13px]">
            <span className="font-semibold text-secondary">{t("riJobRunning", { done: String(job.done), total: String(job.total) })}</span>
            <span className="text-muted">{t("riJobSpent", { n: String(job.spent) })}</span>
          </div>
          <div className="mt-2 h-[6px] overflow-hidden rounded-full bg-chip">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, Math.round((job.done / Math.max(1, job.total)) * 100))}%` }} />
          </div>
        </div>
      )}
      {job?.status === "paused" && (
        <div className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13.5px] text-amber-800">
          {job.reason === "provider"
            ? t("riJobPausedProvider", { done: String(job.done), total: String(job.total) })
            : t("riJobPaused", { done: String(job.done), total: String(job.total) })}
        </div>
      )}

      {/* Status strip */}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[12px] border border-line bg-surface px-4 py-3 text-[13px]">
        <span>
          <span className="text-muted">{t("riTokens")}:</span>{" "}
          <span className={`font-semibold tabular-nums ${balance > 0 ? "" : "text-amber-700"}`}>{balance.toLocaleString()}</span>
        </span>
        <span>
          <span className="text-muted">{t("riCoverage")}:</span>{" "}
          <span className="font-semibold tabular-nums">{t("riCoverageVal", { n: String(datesWithData), total: String(horizon) })}</span>
        </span>
        <span>
          <span className="text-muted">{t("riLastCapture")}:</span>{" "}
          <span className="font-semibold">{fmtWhen(lastCap)}</span>
        </span>
        {balance < 1 && <span className="font-semibold text-amber-700">{t("riPausedBanner")}</span>}
        {/* Whether the guest-facing badge is live. It's driven entirely by these
            captures, so its state belongs here rather than only on the settings
            page the owner may never open. */}
        <span className="ml-auto">
          <span className="text-muted">{t("riCompareStatus")}:</span>{" "}
          {compare.enabled && compare.mapped > 0 ? (
            <Link to="/admin/rate-intel/settings" className="font-semibold text-emerald-700 hover:underline">
              {compare.mapped === 1 ? t("riCompareStatusOn1") : t("riCompareStatusOn", { n: String(compare.mapped) })}
            </Link>
          ) : (
            <Link to="/admin/rate-intel/settings" className="font-semibold text-accent hover:underline">
              {t("riCompareStatusOff")}
            </Link>
          )}
        </span>
      </div>

      {hotels.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-8 text-center text-[13.5px] text-muted">
          {t("riNoCompSet")} <Link to="/admin/revenue" className="text-accent underline">{t("navRevenue")}</Link>.
        </div>
      ) : datesWithData === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-8 text-center">
          <div className="font-serif text-[18px] font-semibold">{t("riEmptyTitle")}</div>
          <p className="mx-auto mt-2 max-w-[460px] text-[13.5px] text-muted">{t("riEmptyBody")}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line">
                <th className="sticky left-0 z-10 bg-surface px-3 py-2.5 text-left font-semibold text-muted">{t("riColDate")}</th>
                {hotels.map((h) => (
                  <th
                    key={h.id}
                    className={`min-w-[92px] px-3 py-2.5 text-right font-semibold ${h.isSelf ? "text-accent" : "text-secondary"}`}
                    title={h.name}
                  >
                    <div className="max-w-[120px] truncate">{h.name}</div>
                    {h.isSelf && <div className="text-[10px] font-bold uppercase tracking-wide text-accent">{t("riYou")}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((d) => (
                <tr key={d} className="border-b border-line-alt last:border-0">
                  <td className="sticky left-0 z-10 bg-surface px-3 py-2 font-medium text-secondary">{fmtDate(d, "EEE d MMM", dl)}</td>
                  {hotels.map((h) => {
                    const c = cells[h.id]?.[d];
                    const isCheapest = c?.minor != null && c.minor === cheapestByDate[d];
                    return (
                      <td
                        key={h.id}
                        className={`px-3 py-2 text-right tabular-nums ${h.isSelf ? "bg-accent/5" : ""} ${
                          isCheapest ? "font-semibold text-emerald-700" : c?.minor == null ? "text-muted" : "text-ink"
                        }`}
                      >
                        {money(c?.minor, c?.currency ?? null)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11.5px] text-muted">{t("riCheapestHint")}</p>

      <RoomPrices
        hotels={hotels}
        dates={dates}
        rooms={loaderData.rooms}
        roomCells={loaderData.roomCells}
        roomsFor={loaderData.roomsFor}
        currency={currency}
        onHotelChange={(id) =>
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.set("rooms", id);
              return next;
            },
            { preventScrollReset: true },
          )
        }
      />
    </div>
  );
}

/** Per-room-type prices for one hotel of the set. Same captures as the grid
 *  above — the hotel page carries every room type, so this costs nothing extra. */
function RoomPrices({
  hotels,
  dates,
  rooms,
  roomCells,
  roomsFor,
  currency,
  onHotelChange,
}: {
  hotels: { id: string; name: string; isSelf: boolean }[];
  dates: string[];
  rooms: { roomRef: string; name: string; maxPersons: number | null }[];
  roomCells: Record<string, Record<string, RoomCell>>;
  roomsFor: string | null;
  currency: string;
  onHotelChange: (id: string) => void;
}) {
  const t = useAdminT();
  const dl = useAdminDateLocale();
  if (hotels.length === 0) return null;
  const money = (minor: number, cur: string | null) => formatMoney(minor / 100, cur || currency);

  // Cheapest room per date, to highlight where each night's entry price sits.
  const cheapest: Record<string, number> = {};
  for (const d of dates) {
    let min = Infinity;
    for (const r of rooms) {
      const c = roomCells[r.roomRef]?.[d];
      if (c && c.minor < min) min = c.minor;
    }
    if (min < Infinity) cheapest[d] = min;
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-[19px] font-semibold">{t("riRoomsTitle")}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{t("riRoomsSub")}</p>
        </div>
        <label className="text-[11px] font-medium text-muted">
          {t("riRoomsHotel")}
          {/* Bare selects don't reliably dispatch in LiveView-style flows; here
              it's a plain React handler, so onChange is fine. */}
          <select
            value={roomsFor ?? ""}
            onChange={(e) => onHotelChange(e.target.value)}
            className="mt-0.5 block rounded-[8px] border border-line-alt bg-surface px-2 py-1.5 text-[13px] font-normal text-ink"
          >
            {hotels.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {h.isSelf ? ` (${t("riYou")})` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rooms.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-center text-[13.5px] text-muted">
          {t("riRoomsNone")}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line">
                  <th className="sticky left-0 z-10 min-w-[190px] bg-surface px-3 py-2.5 text-left font-semibold text-muted">
                    {t("riRoomsColRoom")}
                  </th>
                  {dates.map((d) => (
                    <th key={d} className="min-w-[74px] px-3 py-2.5 text-right font-semibold text-secondary">
                      {fmtDate(d, "EEE d", dl)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rooms.map((r) => (
                  <tr key={r.roomRef} className="border-b border-line-alt last:border-0">
                    <td className="sticky left-0 z-10 bg-surface px-3 py-2">
                      <div className="font-medium text-secondary">{r.name}</div>
                      {r.maxPersons ? (
                        <div className="text-[11px] text-muted">{t("riRoomsSleeps", { n: String(r.maxPersons) })}</div>
                      ) : null}
                    </td>
                    {dates.map((d) => {
                      const c = roomCells[r.roomRef]?.[d];
                      if (!c) return <td key={d} className="px-3 py-2 text-right text-muted">—</td>;
                      const tip = [
                        c.mealPlan ? t("riRoomsMeal", { meal: c.mealPlan }) : t("riRoomsRoomOnly"),
                        c.flexMinor != null
                          ? t("riRoomsFlex", { price: money(c.flexMinor, c.currency) })
                          : t("riRoomsNoFlex"),
                        c.genius ? t("riRoomsGenius") : "",
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <td
                          key={d}
                          title={tip}
                          className={`px-3 py-2 text-right tabular-nums ${
                            c.minor === cheapest[d] ? "font-semibold text-emerald-700" : "text-ink"
                          }`}
                        >
                          {money(c.minor, c.currency)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11.5px] text-muted">{t("riRoomsHint")}</p>
        </>
      )}
    </section>
  );
}
