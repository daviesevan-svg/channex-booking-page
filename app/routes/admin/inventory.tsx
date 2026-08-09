import { Fragment, useEffect, useRef, useState } from "react";
import { addDays, format, parseISO } from "date-fns";
import { Form, Link, useFetcher, useNavigate, useNavigation } from "react-router";

import type { Route } from "./+types/inventory";
import { adminMeta } from "~/lib/admin-meta";
import { useAdminDateLocale, useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getRates, getRooms, pricingModeOf, rateChannexId } from "~/lib/catalog.server";
import { applyBulkUpdate, getInventory, getLastAriReceivedAt, saveInventory, type AriActor, type InventoryEdits } from "~/lib/ari.server";
import { getSettings, isChannexConnected } from "~/lib/overrides.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
// Client-safe (rate-pricing.ts has no server imports) — this runs in the grid to
// show what a blank per-occupancy cell would inherit.
import { perPersonPrice } from "~/lib/rate-pricing";

// Generous server window; the client renders only as many columns as fit the
// screen and pages by that visible count.
const FETCH_DAYS = 31;
const DEFAULT_COLS = 14;

// Day-of-week chips for bulk update. Values are getUTCDay() codes (0 = Sunday).
const DOW = [
  { v: 1, labelKey: "invDowMon" },
  { v: 2, labelKey: "invDowTue" },
  { v: 3, labelKey: "invDowWed" },
  { v: 4, labelKey: "invDowThu" },
  { v: 5, labelKey: "invDowFri" },
  { v: 6, labelKey: "invDowSat" },
  { v: 0, labelKey: "invDowSun" },
];

const MAX_BULK_DAYS = 366;

function windowDates(start: string, n: number): string[] {
  const base = parseISO(start);
  return Array.from({ length: n }, (_, i) => format(addDays(base, i), "yyyy-MM-dd"));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive YYYY-MM-DD dates from `from` to `to`, optionally limited to the
 *  given days of week (0 = Sunday … 6 = Saturday; empty set = all days). */
function rangeDates(from: string, to: string, dows: Set<number>): string[] {
  const out: string[] = [];
  const end = parseISO(to);
  let d = parseISO(from);
  while (d <= end && out.length < MAX_BULK_DAYS) {
    if (dows.size === 0 || dows.has(d.getUTCDay())) out.push(format(d, "yyyy-MM-dd"));
    d = addDays(d, 1);
  }
  return out;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const url = new URL(request.url);
  const start = url.searchParams.get("start") || format(new Date(), "yyyy-MM-dd");
  const dates = windowDates(start, FETCH_DAYS);
  const [rooms, rates, settings, inventory] = await Promise.all([
    getRooms(propertyId),
    getRates(propertyId),
    getSettings(propertyId),
    getInventory(propertyId, dates[0], dates[dates.length - 1]),
  ]);
  const channelManaged = await isChannexConnected(propertyId);
  const lastAriAt = channelManaged ? await getLastAriReceivedAt(propertyId) : null;

  return {
    configured: true as const,
    // maxAdults bounds the per-occupancy rows: a per-person rate is priced for
    // 1..maxAdults adults, the same range the Channex mapping advertises.
    rooms: rooms.map((r) => ({ id: r.id, title: r.title, maxAdults: Math.max(1, r.maxAdults || 1) })),
    // channexRateIds: Channex pushes ARI keyed by each room's real Channex rate
    // id (what the mapping advertises), so per-occupancy lookups need it.
    rates: rates.map((r) => ({ id: r.id, title: r.title, prices: r.prices, channexRateIds: r.channexRateIds })),
    currency: settings.currency || "GBP",
    // A channel-managed property's ARI belongs to the channel manager: it owns
    // availability, prices and restrictions, and its next push overwrites
    // whatever was typed here. The grid is therefore READ-ONLY while connected —
    // see the action, which refuses the write regardless of what the form sends.
    channelManaged,
    // Connected, but the channel manager has never pushed anything: the mapping
    // was most likely started and never finished, so the grid is locked with
    // nothing to show for it. The banner offers the way straight back out.
    channelPending: channelManaged && !lastAriAt,
    // Per-person property: offer to unfold each cell's per-occupancy prices.
    perPerson: pricingModeOf(settings, rates) === "per_person",
    dates,
    start,
    inventory,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const email = await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  // The channel manager owns the ARI of a connected property, so the grid is
  // read-only and this refuses every write — bulk included. Enforced HERE and
  // not only by disabling the inputs: a control you don't render is not a write
  // you can't make, and this endpoint accepts a plain form POST.
  if (await isChannexConnected(propertyId)) {
    return { error: "This property's availability, prices and restrictions come from your channel manager. Change them there." };
  }
  const actor: AriActor = { source: "user", actor: email };

  const form = await request.formData();

  if (String(form.get("intent")) === "bulk") {
    const [rooms, rates, settings] = await Promise.all([
      getRooms(propertyId),
      getRates(propertyId),
      getSettings(propertyId),
    ]);

    const from = String(form.get("from") || "");
    const to = String(form.get("to") || "");
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return { error: "Pick a valid date range." };
    if (to < from) return { error: "End date must be on or after the start date." };

    const dows = new Set(form.getAll("dow").map((d) => Number(d)).filter((n) => n >= 0 && n <= 6));
    const dates = rangeDates(from, to, dows);
    if (!dates.length) return { error: "No dates match the selected days of the week." };

    const room = String(form.get("room") || "all");
    const rate = String(form.get("rate") || "all");
    const scopedRooms = room === "all" ? rooms : rooms.filter((r) => r.id === room);
    const scopedRates = rate === "all" ? rates : rates.filter((r) => r.id === rate);

    // Blank input = leave untouched. A value (including 0 for numbers / "off"
    // for toggles) means set it.
    const num = (key: string) => {
      const v = String(form.get(key) ?? "").trim();
      if (v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const tri = (key: string) => {
      const v = String(form.get(key) ?? "");
      return v === "on" ? true : v === "off" ? false : undefined;
    };

    const avail = num("avail");
    const price = num("price");
    const minStay = num("minStay");
    const stopSell = tri("stopSell");
    const cta = tri("cta");
    const ctd = tri("ctd");

    if (
      avail === undefined &&
      !(price !== undefined && price > 0) &&
      minStay === undefined &&
      stopSell === undefined &&
      cta === undefined &&
      ctd === undefined
    ) {
      return { error: "Enter at least one value to apply." };
    }

    const { cells } = await applyBulkUpdate(propertyId, {
      currency: settings.currency || "GBP",
      dates,
      rooms: scopedRooms.map((r) => ({ id: r.id })),
      rates: scopedRates.map((r) => ({ id: r.id, prices: r.prices, channexRateIds: r.channexRateIds })),
      avail: avail !== undefined ? Math.max(0, Math.round(avail)) : undefined,
      price: price !== undefined && price > 0 ? Math.round(price * 100) / 100 : undefined,
      minStay: minStay !== undefined ? Math.max(0, Math.round(minStay)) : undefined,
      stopSell,
      cta,
      ctd,
    }, actor);

    await queueGoogleAriPush(propertyId, ["ari"]);
    return { ok: true as const, message: `Updated ${cells} cell${cells === 1 ? "" : "s"} across ${dates.length} date${dates.length === 1 ? "" : "s"}.` };
  }

  const start = String(form.get("start") || format(new Date(), "yyyy-MM-dd"));
  // Only the columns the client actually rendered are saved, so paging by a
  // smaller visible window never clears restrictions on off-screen dates.
  const cols = Math.min(FETCH_DAYS, Math.max(1, Math.round(Number(form.get("cols")) || DEFAULT_COLS)));
  const dates = windowDates(start, cols);
  const rates = await getRates(propertyId);
  const settings = await getSettings(propertyId);

  const edits: InventoryEdits = {
    currency: settings.currency || "GBP",
    availability: [],
    prices: [],
    priceDeletes: [],
    restrictions: [],
  };

  for (const [key, value] of form.entries()) {
    const v = String(value).trim();
    const parts = key.split(":");
    if (parts[0] === "a") {
      // availability: a:roomId:date
      const [, roomId, date] = parts;
      if (date && v !== "") edits.availability.push({ roomId, date, avail: Math.max(0, Math.round(Number(v)) || 0) });
    } else if (parts[0] === "p") {
      // price: p:roomId:rateId:date — rateId is the room's Channex rate id for
      // consolidated imported rates (the grid renders it), i.e. the storage id.
      const [, roomId, rateId, date] = parts;
      if (!date || v === "") continue;
      const price = Math.round(Number(v) * 100) / 100;
      if (price > 0) edits.prices.push({ roomId, rateId, date, price });
    } else if (parts[0] === "po") {
      // per-occupancy price: po:roomId:rateId:date:adults — the rows the
      // "Occupancy prices" toggle reveals. Unlike every other field here, BLANK
      // means delete: an override can only be undone by clearing it, and
      // leaving the stored row in place would make the save look ignored.
      const [, roomId, rateId, date, adults] = parts;
      const occupancy = Math.round(Number(adults));
      if (!date || !Number.isFinite(occupancy) || occupancy < 1) continue;
      if (v === "") {
        edits.priceDeletes.push({ roomId, rateId, date, occupancy });
        continue;
      }
      const price = Math.round(Number(v) * 100) / 100;
      if (price > 0) edits.prices.push({ roomId, rateId, date, price, occupancy });
    }
  }
  // Restrictions cover every (room, its rates) × date in the window so toggles
  // clear too. A rate is offered on a room only when it has a price for it.
  // Keyed by the per-room Channex rate id (= rate.id for native rates), matching
  // both the field names the grid rendered and the rows guest pricing reads.
  for (const rate of rates) {
    for (const roomId of Object.keys(rate.prices)) {
      const rid = rateChannexId(rate, roomId);
      for (const date of dates) {
        const suffix = `${roomId}:${rid}:${date}`;
        edits.restrictions.push({
          rateId: rid,
          roomId,
          date,
          stopSell: form.get(`s:${suffix}`) != null,
          minStay: Math.max(0, Math.round(Number(form.get(`m:${suffix}`)) || 0)),
          cta: form.get(`ca:${suffix}`) != null,
          ctd: form.get(`cd:${suffix}`) != null,
        });
      }
    }
  }

  await saveInventory(propertyId, edits, actor);
  await queueGoogleAriPush(propertyId, ["ari"]);
  return { ok: true };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navInventory" });
}

const cellInput =
  "w-full rounded-[6px] border border-line-alt bg-surface px-1.5 py-1 text-center text-[13px] text-ink outline-none focus:border-accent";

const bulkField = "rounded-[8px] border border-line-alt bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent";
const bulkLabel = "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-faint";

function Toggle({
  name,
  label,
  title,
  checked,
  danger,
}: {
  name: string;
  label: string;
  title: string;
  checked?: boolean;
  danger?: boolean;
}) {
  const on = danger
    ? "peer-checked:border-[#c0392b] peer-checked:bg-[#fbe9e7] peer-checked:text-[#c0392b]"
    : "peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent-deep";
  return (
    <label title={title} className="cursor-pointer">
      <input type="checkbox" name={name} defaultChecked={checked} className="peer sr-only" />
      <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border border-line-alt text-[10px] font-semibold text-muted-2 ${on}`}>
        {label}
      </span>
    </label>
  );
}

export default function AdminInventory({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const dl = useAdminDateLocale();
  const nav = useNavigation();
  const navigate = useNavigate();
  const saving = nav.state === "submitting";
  // Render only the date columns that fit the available width — no horizontal
  // scroll. Recomputed on resize; SSR/first paint uses DEFAULT_COLS to match.
  const gridRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(DEFAULT_COLS);
  // Which room's card to show ("all" = every room). Purely a view filter —
  // hidden cards stay in the DOM so Save still submits their values.
  const [roomFilter, setRoomFilter] = useState<string>("all");
  const [bulkOpen, setBulkOpen] = useState(false);
  // Per-person properties: unfold each cell's per-occupancy prices (read-only —
  // they come from Channex pushes; the editable price is the occupancy-0 row).
  const [showOcc, setShowOcc] = useState(false);
  // Undoes an unfinished channel-manager connection from the banner below.
  const disconnectFetcher = useFetcher();
  const datesLen = loaderData.configured ? loaderData.dates.length : 0;
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const LABEL = 200;
      const COL = 92;
      const fit = Math.floor((el.clientWidth - LABEL) / COL);
      setVisible(Math.max(1, Math.min(datesLen || 1, fit)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [datesLen]);

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("invTitle")}</h1>
        <p className="text-[15px] text-secondary">
          {t("invConfigurePrefix")} <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code>{" "}
          {t("invConfigureSuffix")}
        </p>
      </div>
    );
  }

  const { rooms, rates, currency, dates, start, inventory, perPerson, channelManaged, channelPending } = loaderData;
  const shown = dates.slice(0, visible);
  const go = (s: string) => navigate(`/admin/inventory?start=${s}`);
  const today = format(new Date(), "yyyy-MM-dd");
  const prevStart = format(addDays(parseISO(start), -visible), "yyyy-MM-dd");
  const nextStart = format(addDays(parseISO(start), visible), "yyyy-MM-dd");
  const dow = (d: string) => parseISO(d).getUTCDay();
  const isWeekend = (d: string) => dow(d) === 0 || dow(d) === 6;

  if (rooms.length === 0) {
    return (
      <div>
        <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("invTitle")}</h1>
        <div className="mt-4 rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          {t("invCreateRoomPrefix")} <Link to="/admin/rooms/new" className="font-semibold text-accent">{t("invCreateRoomLink")}</Link>{" "}
          {t("invCreateRoomSuffix")}
        </div>
      </div>
    );
  }

  const headCell = "sticky top-0 z-10 bg-surface-alt px-2 py-2 text-center text-[12px] font-semibold";
  const labelCell = "sticky left-0 z-10 bg-surface px-3 py-2 text-left text-[13px]";

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[26px] font-semibold">{t("invTitle")}</h1>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <input
            type="date"
            value={start}
            onChange={(e) => e.target.value && go(e.target.value)}
            aria-label={t("invJumpToDate")}
            className="rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-ink outline-none focus:border-accent"
          />
          <button type="button" onClick={() => go(today)} className="rounded-[8px] border border-line-alt px-2.5 py-1.5 hover:border-accent hover:text-accent">
            {t("invToday")}
          </button>
          <button type="button" onClick={() => go(prevStart)} aria-label={t("invPrevDates")} className="rounded-[8px] border border-line-alt px-2.5 py-1.5 hover:border-accent hover:text-accent">←</button>
          <span className="text-muted-2">
            {format(parseISO(shown[0]), "d MMM", { locale: dl })} –{" "}
            {format(parseISO(shown[shown.length - 1]), "d MMM yyyy", { locale: dl })}
          </span>
          <button type="button" onClick={() => go(nextStart)} aria-label={t("invNextDates")} className="rounded-[8px] border border-line-alt px-2.5 py-1.5 hover:border-accent hover:text-accent">→</button>
        </div>
      </div>
      {channelManaged && (
        <div
          className={`mb-5 rounded-[10px] px-4 py-2.5 text-[13px] ${
            channelPending ? "border border-amber-200 bg-amber-50 text-amber-900" : "bg-chip text-secondary"
          }`}
        >
          <p>
            {channelPending ? t("invChannelPending") : t("invChannelManaged")}{" "}
            <Link to="/admin/connectivity" className="font-semibold text-accent">
              {t("navConnectivity")}
            </Link>
          </p>
          {/* The connection was never completed, so let it be undone from the
              page it locked. A fetcher, not a <Form>: a navigation submission to
              another route's action also NAVIGATES there, which would dump you on
              Connectivity. The fetcher posts, revalidates this loader and unlocks
              the grid in place — which is what the button promises. */}
          {channelPending && (
            <disconnectFetcher.Form method="post" action="/admin/connectivity" className="mt-2.5">
              <input type="hidden" name="intent" value="disconnect" />
              <button
                type="submit"
                disabled={disconnectFetcher.state !== "idle"}
                className="rounded-[8px] border border-amber-300 bg-surface px-3 py-1.5 text-[13px] font-semibold text-amber-900 hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {t("invCancelConnection")}
              </button>
            </disconnectFetcher.Form>
          )}
        </div>
      )}
      <p className="mb-5 text-[14px] text-muted">
        {t("invIntroLead", { currency })}{" "}
        <span className="font-semibold text-[#c0392b]">✕</span> {t("invIntroClosed")}{" "}
        <span className="font-semibold text-accent">A</span> {t("invIntroNoArrival")}{" "}
        <span className="font-semibold text-accent">D</span> {t("invIntroNoDeparture")}
      </p>

      {/* Bulk update is an editing tool only — nothing to show read-only. */}
      <div className="mb-5 rounded-[14px] border border-line bg-surface" hidden={channelManaged}>
        <button
          type="button"
          onClick={() => setBulkOpen((v) => !v)}
          aria-expanded={bulkOpen}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="font-serif text-[16px] font-semibold">{t("invBulkUpdate")}</span>
          <span className="text-[13px] font-semibold text-muted-2">
            {bulkOpen ? t("invBulkHide") : t("invBulkShow")}
          </span>
        </button>
        {bulkOpen && (
          <Form method="post" className="space-y-4 border-t border-divider px-4 py-4">
            <input type="hidden" name="intent" value="bulk" />

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className={bulkLabel}>{t("invFrom")}</span>
                <input type="date" name="from" defaultValue={start} required className={`${bulkField} w-full`} />
              </label>
              <label className="block">
                <span className={bulkLabel}>{t("invTo")}</span>
                <input
                  type="date"
                  name="to"
                  defaultValue={format(addDays(parseISO(start), 13), "yyyy-MM-dd")}
                  required
                  className={`${bulkField} w-full`}
                />
              </label>
              <label className="block">
                <span className={bulkLabel}>{t("invRoom")}</span>
                <select name="room" defaultValue="all" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="all">{t("invAllRooms")}</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>{r.title}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={bulkLabel}>{t("invRate")}</span>
                <select name="rate" defaultValue="all" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="all">{t("invAllRates")}</option>
                  {rates.map((r) => (
                    <option key={r.id} value={r.id}>{r.title}</option>
                  ))}
                </select>
              </label>
            </div>

            <div>
              <span className={bulkLabel}>{t("invDaysOfWeek")}</span>
              <div className="flex flex-wrap gap-1.5">
                {DOW.map((d) => (
                  <label key={d.v} className="cursor-pointer">
                    <input type="checkbox" name="dow" value={d.v} defaultChecked className="peer sr-only" />
                    <span className="inline-block rounded-[8px] border border-line-alt px-3 py-1.5 text-[12px] font-semibold text-muted-2 peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent-deep">
                      {t(d.labelKey)}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className={bulkLabel}>{t("invAvailability")}</span>
                <input type="number" name="avail" min={0} placeholder={t("invLeaveBlank")} className={`${bulkField} w-full`} />
              </label>
              <label className="block">
                <span className={bulkLabel}>{t("invPriceCurrency", { currency })}</span>
                <input type="number" name="price" min={0} step="0.01" placeholder={t("invLeaveBlank")} className={`${bulkField} w-full`} />
              </label>
              <label className="block">
                <span className={bulkLabel}>{t("invMinStay")}</span>
                <input type="number" name="minStay" min={0} placeholder={t("invLeaveBlank")} className={`${bulkField} w-full`} />
              </label>
              <label className="block">
                <span className={bulkLabel}>{t("invClosedStopSell")}</span>
                <select name="stopSell" defaultValue="" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="">{t("invLeaveUnchanged")}</option>
                  <option value="on">{t("invCloseStopSell")}</option>
                  <option value="off">{t("invOpen")}</option>
                </select>
              </label>
              <label className="block">
                <span className={bulkLabel}>{t("invNoArrivalCta")}</span>
                <select name="cta" defaultValue="" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="">{t("invLeaveUnchanged")}</option>
                  <option value="on">{t("invNoCheckIn")}</option>
                  <option value="off">{t("invAllowCheckIn")}</option>
                </select>
              </label>
              <label className="block">
                <span className={bulkLabel}>{t("invNoDepartureCtd")}</span>
                <select name="ctd" defaultValue="" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="">{t("invLeaveUnchanged")}</option>
                  <option value="on">{t("invNoCheckOut")}</option>
                  <option value="off">{t("invAllowCheckOut")}</option>
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
              >
                {saving ? t("invApplying") : t("invApplyToRange")}
              </button>
              <p className="text-[12px] text-muted-2">
                {t("invBulkHint")}
              </p>
            </div>
          </Form>
        )}
      </div>

      <Form method="post">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="start" value={start} />
        <input type="hidden" name="cols" value={visible} />
        <div className="mb-4 flex items-center gap-3">
          {!channelManaged && (
            <button
              type="submit"
              disabled={saving}
              className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {saving ? t("saving") : t("saveChanges")}
            </button>
          )}
          {actionData?.ok && (
            <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
              ✓ {actionData.message ?? t("invSaved")}
            </span>
          )}
          {actionData?.error && <span className="text-[13px] text-red-600">{actionData.error}</span>}
          <div className="ml-auto flex items-center gap-2 text-[13px] font-semibold">
            {perPerson && (
              <label className="mr-2 flex cursor-pointer items-center gap-1.5 text-muted-2">
                <input
                  type="checkbox"
                  checked={showOcc}
                  onChange={(e) => setShowOcc(e.target.checked)}
                  className="h-4 w-4 rounded border-line-alt text-accent focus:ring-accent"
                />
                {t("invShowOccPrices")}
              </label>
            )}
            <label htmlFor="roomFilter" className="text-muted-2">{t("invShow")}</label>
            <select
              id="roomFilter"
              value={roomFilter}
              onChange={(e) => setRoomFilter(e.target.value)}
              className="cursor-pointer rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-ink outline-none focus:border-accent"
            >
              <option value="all">{t("invAllRooms")}</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.title}</option>
              ))}
            </select>
          </div>
        </div>

        {/* One disabled fieldset makes every cell in the grid read-only —
            availability, prices, min stay and the three toggles — and keeps
            them out of the submission, so a future cell is covered without
            remembering to gate it. The paging and filter controls sit above,
            outside it, and stay usable. */}
        <fieldset disabled={channelManaged}>
        <div ref={gridRef} className="flex flex-col gap-5">
          {rooms.map((room) => {
            const roomRates = rates.filter((r) => r.prices[room.id] !== undefined);
            // Hidden (not unmounted) when filtered out, so inputs still submit.
            const hidden = roomFilter !== "all" && roomFilter !== room.id;
            return (
              <div
                key={room.id}
                hidden={hidden}
                className="overflow-hidden rounded-[14px] border border-line bg-surface"
              >
                <div className="flex items-center justify-between gap-3 border-b border-divider bg-surface-alt/50 px-4 py-3">
                  <div className="font-serif text-[16px] font-semibold">{room.title}</div>
                  <div className="text-[12px] text-muted-2">
                    {t(roomRates.length === 1 ? "invRatesCount_one" : "invRatesCount_other", { n: roomRates.length })}
                  </div>
                </div>
                <table className="w-full table-fixed border-collapse text-[13px]">
                  <colgroup>
                    <col style={{ width: 200 }} />
                    {shown.map((d) => (
                      <col key={d} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th className={`${labelCell} ${headCell}`} />
                      {shown.map((d) => (
                        <th key={d} className={`${headCell} ${isWeekend(d) ? "text-accent" : "text-muted-2"}`}>
                          <div>{format(parseISO(d), "EEE", { locale: dl })}</div>
                          <div className="text-[13px] font-bold text-ink">{format(parseISO(d), "d")}</div>
                          <div className="text-[10px] font-normal text-faint">{format(parseISO(d), "MMM", { locale: dl })}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Room availability row */}
                    <tr className="border-t border-divider bg-surface-alt/40">
                      <td className={`${labelCell} bg-surface-alt/40 font-semibold`}>
                        {t("invAvailability")}
                      </td>
                      {shown.map((d) => (
                        <td key={d} className={`px-1.5 py-1.5 ${isWeekend(d) ? "bg-field-hover/40" : ""}`}>
                          <input
                            name={`a:${room.id}:${d}`}
                            type="number"
                            min={0}
                            defaultValue={inventory.availability[`${room.id}|${d}`] ?? ""}
                            placeholder="—"
                            className={cellInput}
                          />
                        </td>
                      ))}
                    </tr>
                    {/* Rate rows: price + restrictions */}
                    {roomRates.map((rate) => {
                      // All ARI — Channex pushes and our own edits — is stored
                      // under the room's real Channex rate id, which for a
                      // consolidated imported rate differs from our single
                      // rate.id on all but one room. Display and the submitted
                      // field names both use it so edits land on the rows guest
                      // pricing actually reads.
                      const rid = rate.channexRateIds?.[room.id] ?? rate.id;
                      const base = rate.prices[room.id];
                      // One editable row per adult count, as Channex shows them.
                      const occRows = showOcc ? Array.from({ length: room.maxAdults }, (_, i) => i + 1) : [];
                      return (
                        <Fragment key={rate.id}>
                          <tr className="border-t border-divider/60">
                            <td className={labelCell}>
                              <div className="font-medium">{rate.title}</div>
                              <div className="text-[11px] text-muted-2">{t("invCellLegend")}</div>
                              {showOcc && (
                                <div className="text-[11px] font-medium text-muted-2">{t("invOccDefaultRow")}</div>
                              )}
                            </td>
                            {shown.map((d) => {
                              const key = `${room.id}|${rid}|${d}`;
                              const suffix = `${room.id}:${rid}:${d}`;
                              const restr = inventory.restrictions[key];
                              // The channel owns this cell's price once it has
                              // pushed one for a party size (occupancy>=1), and
                              // its value wins on read. The box is DISABLED
                              // rather than merely ignored: typing here used to
                              // look like it worked while the display kept
                              // showing the channel's number. Disabled (not
                              // read-only) so it isn't submitted at all — a
                              // resubmitted copy would only add a dead
                              // occupancy-0 row per visible cell.
                              const channelPriced = Object.keys(inventory.pricesByOcc[key] ?? {}).some(
                                (o) => Number(o) > 0,
                              );
                              return (
                                <td key={d} className={`px-1.5 py-1.5 align-top ${isWeekend(d) ? "bg-field-hover/40" : ""}`}>
                                  <input
                                    name={`p:${suffix}`}
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    defaultValue={inventory.prices[key] ?? ""}
                                    placeholder={base.toFixed(0)}
                                    disabled={channelPriced}
                                    title={channelPriced ? t("invChannelPriced") : undefined}
                                    className={`${cellInput} ${channelPriced ? "text-muted-2" : ""}`}
                                  />
                                  <div className="mt-1 flex items-center justify-center gap-1">
                                    <input
                                      name={`m:${suffix}`}
                                      type="number"
                                      min={0}
                                      defaultValue={restr?.minStay || ""}
                                      title={t("invMinimumStay")}
                                      placeholder="0"
                                      className="w-8 rounded-[6px] border border-line-alt bg-surface px-1 py-0.5 text-center text-[11px] outline-none focus:border-accent"
                                    />
                                    <Toggle name={`s:${suffix}`} label="✕" title={t("invClosedStopSell")} checked={restr?.stopSell} danger />
                                    <Toggle name={`ca:${suffix}`} label="A" title={t("invClosedToArrival")} checked={restr?.cta} />
                                    <Toggle name={`cd:${suffix}`} label="D" title={t("invClosedToDeparture")} checked={restr?.ctd} />
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                          {/* Per-occupancy prices: the real selling prices of a
                              per-person rate, edited exactly like the row above.
                              Restrictions stay on that row — stop-sell and
                              min-stay are per date, not per adult count. */}
                          {occRows.map((occ) => (
                            <tr key={`${rate.id}:${occ}`} className="border-t border-divider/40 bg-surface-alt/30">
                              <td className={`${labelCell} bg-surface-alt/30`}>
                                <div className="flex items-center gap-1.5 pl-3 text-[12px] font-medium text-secondary">
                                  <span aria-hidden="true">👤</span>
                                  {t(occ === 1 ? "invAdults_one" : "invAdults_other", { n: occ })}
                                </div>
                              </td>
                              {shown.map((d) => {
                                const key = `${room.id}|${rid}|${d}`;
                                const byOcc = inventory.pricesByOcc[key];
                                // Placeholder = what this cell would charge if
                                // left blank, so an inherited price is visible
                                // rather than looking unset. Computed WITHOUT
                                // this occupancy, which is what deleting it
                                // leaves behind.
                                const { [occ]: _own, ...rest } = byOcc ?? {};
                                const inherited = perPersonPrice(rest, occ) ?? base * occ;
                                return (
                                  <td key={d} className={`px-1.5 py-1.5 ${isWeekend(d) ? "bg-field-hover/40" : ""}`}>
                                    <input
                                      name={`po:${room.id}:${rid}:${d}:${occ}`}
                                      type="number"
                                      min={0}
                                      step="0.01"
                                      defaultValue={byOcc?.[occ] ?? ""}
                                      placeholder={inherited.toFixed(0)}
                                      title={t("invOccPricesTitle")}
                                      // Muted placeholder: on these rows the
                                      // difference between a price that IS set
                                      // and one merely inherited is the point,
                                      // so the two must not look alike.
                                      className={`${cellInput} placeholder:text-faint`}
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                    {roomRates.length === 0 && (
                      <tr className="border-t border-divider/60">
                        <td className={labelCell} colSpan={shown.length + 1}>
                          <span className="text-[12px] text-muted-2">
                            {t("invNoRatesForRoom")}
                          </span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
        </fieldset>
      </Form>
    </div>
  );
}
