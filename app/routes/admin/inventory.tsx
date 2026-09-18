import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { addDays, format, parseISO } from "date-fns";
import { Form, Link, useBlocker, useFetcher, useNavigate, useNavigation } from "react-router";

import type { Route } from "./+types/inventory";
import { adminMeta } from "~/lib/admin-meta";
import { SavedPill } from "~/components/admin-page-header";
import { useAdminDateLocale, useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getRates, getRooms, pricingModeOf, rateChannexId } from "~/lib/catalog.server";
import { applyBulkUpdate, saveInventory, type InventoryEdits } from "~/lib/ari/admin.server";
import { getLastAriReceivedAt } from "~/lib/ari/ingest.server";
import type { AriActor } from "~/lib/ari/log.server";
import { getInventory } from "~/lib/ari/read.server";
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
    // Whether any restriction is set in the loaded window — the grid opens
    // with the restriction rows shown when there is something to see.
    hasRestrictions: Object.values(inventory.restrictions).some(
      (r) => r.stopSell || r.cta || r.ctd || r.minStay > 0 || r.maxStay > 0,
    ),
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
    const maxStay = num("maxStay");
    const stopSell = tri("stopSell");
    const cta = tri("cta");
    const ctd = tri("ctd");

    if (
      avail === undefined &&
      !(price !== undefined && price > 0) &&
      minStay === undefined &&
      maxStay === undefined &&
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
      maxStay: maxStay !== undefined ? Math.max(0, Math.round(maxStay)) : undefined,
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
          maxStay: Math.max(0, Math.round(Number(form.get(`x:${suffix}`)) || 0)),
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
  "h-8 w-full rounded-[6px] border border-line-alt bg-surface px-1.5 text-center text-[13px] tabular-nums text-ink outline-none placeholder:text-faint focus:border-accent disabled:cursor-not-allowed disabled:bg-surface-alt disabled:text-muted-2";
const bulkField = "rounded-[8px] border border-line-alt bg-surface px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";
const bulkLabel = "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-faint";
const toolBtn =
  "rounded-[8px] border border-line-alt bg-surface px-2.5 py-1.5 text-[13px] font-semibold text-ink hover:border-accent hover:text-accent disabled:opacity-50 disabled:hover:border-line-alt disabled:hover:text-ink";
const primaryBtn = "rounded-[10px] bg-accent px-4 py-2 text-[13px] font-semibold text-white hover:bg-accent-deep disabled:opacity-50";
const secondaryBtn = "rounded-[10px] border border-line-alt bg-surface px-4 py-2 text-[13px] font-semibold text-ink hover:border-accent hover:text-accent";

/** One restriction flag filling its cell: reads "Open" until ticked, then
 *  "Closed" on a tinted background — so a row of flags scans like a row of
 *  words, not a row of tiny checkboxes. The input is the label's own child, so
 *  `has-checked:` styles the cell and `peer-checked:` swaps the word. */
function FlagCell({
  name,
  checked,
  title,
  danger,
  offLabel,
  onLabel,
}: {
  name: string;
  checked?: boolean;
  title: string;
  danger?: boolean;
  offLabel: string;
  onLabel: string;
}) {
  const on = danger
    ? "has-checked:border-danger-line has-checked:bg-danger-soft has-checked:text-danger"
    : "has-checked:border-accent has-checked:bg-accent-soft has-checked:text-accent-deep";
  return (
    <label
      title={title}
      className={`flex h-8 cursor-pointer items-center justify-center rounded-[6px] border border-line-alt text-[12px] font-semibold text-faint has-focus-visible:ring-2 has-focus-visible:ring-accent-soft-strong has-disabled:cursor-not-allowed ${on}`}
    >
      <input type="checkbox" name={name} defaultChecked={checked} className="peer sr-only" />
      <span className="peer-checked:hidden">{offLabel}</span>
      <span className="hidden peer-checked:inline">{onLabel}</span>
    </label>
  );
}

/** A labelled on/off switch for the view toolbar (client state only). */
function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] font-semibold text-secondary">
      <span
        role="switch"
        aria-checked={checked}
        className={`relative inline-flex h-[18px] w-[32px] items-center rounded-full border transition-colors ${
          checked ? "border-accent bg-accent" : "border-line-alt bg-surface-alt"
        }`}
      >
        <span className={`absolute h-[12px] w-[12px] rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[16px]" : "translate-x-[2px]"}`} />
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
      {children}
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
  // Which room to show ("all" = every room). Purely a view filter — hidden
  // rooms stay in the DOM so Save still submits their values.
  const [roomFilter, setRoomFilter] = useState<string>("all");
  // Restriction rows (min/max stay, closed, no arrival, no departure) are
  // folded away by default unless the loaded window already carries some:
  // most days an operator is here for availability and prices, and a grid of
  // flags nobody set is noise. Hidden rows stay mounted so Save still covers
  // them (a hidden checkbox is still a submitted, or deliberately absent, one).
  const [showRestr, setShowRestr] = useState(() => loaderData.configured && loaderData.hasRestrictions);
  const [bulkOpen, setBulkOpen] = useState(false);
  // Per-person properties: unfold each cell's per-occupancy prices.
  const [showOcc, setShowOcc] = useState(false);
  // Undoes an unfinished channel-manager connection from the banner below.
  const disconnectFetcher = useFetcher();
  const datesLen = loaderData.configured ? loaderData.dates.length : 0;
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const LABEL = 220;
      const COL = 88;
      const fit = Math.floor((el.clientWidth - LABEL) / COL);
      setVisible(Math.max(1, Math.min(datesLen || 1, fit)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [datesLen]);

  // Unsaved-change tracking. The grid is uncontrolled (hundreds of inputs), so
  // rather than mirror it in state we count inputs whose current value differs
  // from the value they rendered with. That count drives the Save button, the
  // floating bar and the leave-page guard; a successful save re-renders every
  // input with the stored value, which brings the count back to zero.
  const formRef = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(0);
  const recount = () => {
    const f = formRef.current;
    if (!f) return;
    let n = 0;
    for (const el of Array.from(f.elements)) {
      if (!(el instanceof HTMLInputElement) || el.disabled) continue;
      if (el.type === "checkbox") {
        if (el.checked !== el.defaultChecked) n++;
      } else if (el.type === "number") {
        if (el.value !== el.defaultValue) n++;
      }
    }
    setDirty(n);
  };
  const inventoryRef = loaderData.configured ? loaderData.inventory : null;
  useEffect(() => {
    recount();
  }, [inventoryRef]);
  const discard = () => {
    formRef.current?.reset();
    recount();
  };
  // In-app navigation (paging dates, the sidebar) with edits pending. Saving
  // is itself a navigation — a POST back to this same URL — so only a change
  // of destination is blocked, never the submission that clears the edits.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty > 0 && (nextLocation.pathname !== currentLocation.pathname || nextLocation.search !== currentLocation.search),
  );
  // Closing the tab with edits pending.
  useEffect(() => {
    if (dirty === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  // A successful bulk apply closes the drawer; its message shows in the toolbar.
  const bulkDone = Boolean(actionData?.ok && actionData?.message);
  useEffect(() => {
    if (bulkDone) setBulkOpen(false);
  }, [bulkDone, actionData]);
  // Escape closes the drawer.
  useEffect(() => {
    if (!bulkOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBulkOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bulkOpen]);

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
  const readOnly = channelManaged;

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

  // Cell background: today gets a soft accent wash, weekends a faint tint.
  const dayBg = (d: string) => (d === today ? "bg-accent-soft/40" : isWeekend(d) ? "bg-surface-alt/60" : "");
  const cell = (d: string) => `px-1 py-1 ${dayBg(d)}`;
  const labelCell = "whitespace-nowrap px-4 py-1 text-left text-[13px]";
  const subLabel = `${labelCell} pl-7 text-[12px] text-secondary`;

  return (
    <div>
      {/* Title row: name on the left, date navigation on the right. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[26px] font-semibold">{t("invTitle")}</h1>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => go(prevStart)} aria-label={t("invPrevDates")} className={toolBtn}>←</button>
          <label className="relative">
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center whitespace-nowrap rounded-[8px] border border-line-alt bg-surface px-3 text-[13px] font-semibold text-ink">
              {format(parseISO(shown[0]), "d MMM", { locale: dl })} – {format(parseISO(shown[shown.length - 1]), "d MMM yyyy", { locale: dl })}
            </span>
            {/* The native date picker sits invisibly over the range label, so
                clicking the range opens the calendar without a second control. */}
            <input
              type="date"
              value={start}
              onChange={(e) => e.target.value && go(e.target.value)}
              aria-label={t("invJumpToDate")}
              className="h-[34px] w-[190px] cursor-pointer opacity-0"
            />
          </label>
          <button type="button" onClick={() => go(nextStart)} aria-label={t("invNextDates")} className={toolBtn}>→</button>
          <button type="button" onClick={() => go(today)} disabled={start === today} className={`${toolBtn} ml-1`}>
            {t("invToday")}
          </button>
        </div>
      </div>

      {channelManaged && (
        <div
          className={`mb-4 flex flex-wrap items-center gap-x-2 gap-y-2 rounded-[10px] border px-4 py-2.5 text-[13px] ${
            channelPending ? "border-notice-line bg-notice-soft text-notice" : "border-line bg-chip text-secondary"
          }`}
        >
          <span aria-hidden="true">🔒</span>
          <p className="min-w-0 flex-1">
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
            <disconnectFetcher.Form method="post" action="/admin/connectivity">
              <input type="hidden" name="intent" value="disconnect" />
              <button type="submit" disabled={disconnectFetcher.state !== "idle"} className={secondaryBtn}>
                {t("invCancelConnection")}
              </button>
            </disconnectFetcher.Form>
          )}
        </div>
      )}

      {/* View toolbar: what to show on the left, what to do on the right. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <select
          aria-label={t("invShow")}
          value={roomFilter}
          onChange={(e) => setRoomFilter(e.target.value)}
          className="cursor-pointer rounded-[8px] border border-line-alt bg-surface px-2.5 py-1.5 text-[13px] font-semibold text-ink outline-none focus:border-accent"
        >
          <option value="all">{t("invAllRooms")}</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>{r.title}</option>
          ))}
        </select>
        <Switch checked={showRestr} onChange={setShowRestr}>{t("invShowRestrictions")}</Switch>
        {perPerson && <Switch checked={showOcc} onChange={setShowOcc}>{t("invShowOccPrices")}</Switch>}
        <div className="ml-auto flex items-center gap-2">
          <SavedPill show={Boolean(actionData?.ok)}>✓ {actionData?.message ?? t("invSaved")}</SavedPill>
          {actionData?.error && <span className="text-[13px] text-danger">{actionData.error}</span>}
          {!readOnly && (
            <>
              <button type="button" onClick={() => setBulkOpen(true)} className={secondaryBtn}>
                {t("invBulkEdit")}
              </button>
              <button type="submit" form="inventory-form" disabled={saving || dirty === 0} className={primaryBtn}>
                {saving ? t("saving") : t("saveChanges")}
              </button>
            </>
          )}
        </div>
      </div>

      <Form method="post" id="inventory-form" ref={formRef} onInput={recount} onChange={recount} onKeyUp={recount} onReset={() => setTimeout(recount, 0)}>
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="start" value={start} />
        <input type="hidden" name="cols" value={visible} />
        {/* One disabled fieldset makes every cell read-only — availability,
            prices, stays and flags — and keeps them out of the submission, so a
            future cell is covered without remembering to gate it. */}
        <fieldset disabled={readOnly} className="min-w-0">
          <div ref={gridRef} className="overflow-clip rounded-[14px] border border-line bg-surface">
            <table className="w-full table-fixed border-collapse text-[13px]">
              <colgroup>
                <col style={{ width: 220 }} />
                {shown.map((d) => (
                  <col key={d} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th className="sticky top-0 z-10 border-b border-line bg-surface-alt" />
                  {shown.map((d) => (
                    <th
                      key={d}
                      className={`sticky top-0 z-10 border-b border-line bg-surface-alt px-1 py-2 text-center font-semibold ${
                        d === today ? "text-accent" : isWeekend(d) ? "text-muted" : "text-muted-2"
                      }`}
                    >
                      <div className="text-[11px] uppercase tracking-wider">{format(parseISO(d), "EEE", { locale: dl })}</div>
                      <div
                        className={`mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-[13px] font-bold ${
                          d === today ? "bg-accent text-white" : "text-ink"
                        }`}
                      >
                        {format(parseISO(d), "d")}
                      </div>
                      <div className="text-[10px] font-normal text-faint">{format(parseISO(d), "MMM", { locale: dl })}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rooms.map((room) => {
                  const roomRates = rates.filter((r) => r.prices[room.id] !== undefined);
                  // Hidden (not unmounted) when filtered out, so inputs still submit.
                  const hidden = roomFilter !== "all" && roomFilter !== room.id;
                  return (
                    <Fragment key={room.id}>
                      <tr hidden={hidden} className="border-t border-line bg-surface-alt/70">
                        <td colSpan={shown.length + 1} className="px-4 pb-1.5 pt-3">
                          <div className="flex items-baseline gap-2">
                            <span className="font-serif text-[15px] font-semibold">{room.title}</span>
                            <span className="text-[12px] text-muted-2">
                              {t(roomRates.length === 1 ? "invRatesCount_one" : "invRatesCount_other", { n: roomRates.length })}
                            </span>
                          </div>
                        </td>
                      </tr>
                      <tr hidden={hidden} className="bg-surface-alt/40">
                        <td className={`${labelCell} font-semibold`}>{t("invAvailability")}</td>
                        {shown.map((d) => (
                          <td key={d} className={cell(d)}>
                            <input
                              name={`a:${room.id}:${d}`}
                              type="number"
                              min={0}
                              defaultValue={inventory.availability[`${room.id}|${d}`] ?? ""}
                              placeholder="—"
                              className={`${cellInput} font-semibold`}
                            />
                          </td>
                        ))}
                      </tr>
                      {roomRates.map((rate) => {
                        // All ARI — Channex pushes and our own edits — is stored
                        // under the room's real Channex rate id, which for a
                        // consolidated imported rate differs from our single
                        // rate.id on all but one room. Display and the submitted
                        // field names both use it so edits land on the rows guest
                        // pricing actually reads.
                        const rid = rate.channexRateIds?.[room.id] ?? rate.id;
                        const base = rate.prices[room.id];
                        const occRows = showOcc ? Array.from({ length: room.maxAdults }, (_, i) => i + 1) : [];
                        const at = (d: string) => {
                          const key = `${room.id}|${rid}|${d}`;
                          return { key, suffix: `${room.id}:${rid}:${d}`, restr: inventory.restrictions[key] };
                        };
                        return (
                          <Fragment key={rate.id}>
                            {/* Price row carries the rate's name: price is the
                                value a rate is about, the rest hangs off it. */}
                            <tr hidden={hidden} className="border-t border-divider/60">
                              <td className={labelCell}>
                                <div className="font-medium">{rate.title}</div>
                                <div className="text-[11px] text-muted-2">
                                  {t("invPriceCurrency", { currency })}
                                  {showOcc && <> · {t("invOccDefaultRow")}</>}
                                </div>
                              </td>
                              {shown.map((d) => {
                                const { key, suffix } = at(d);
                                // The channel owns this cell's price once it has
                                // pushed one for a party size (occupancy>=1), and
                                // its value wins on read. The box is DISABLED
                                // rather than merely ignored: typing here used to
                                // look like it worked while the display kept
                                // showing the channel's number. Disabled (not
                                // read-only) so it isn't submitted at all — a
                                // resubmitted copy would only add a dead
                                // occupancy-0 row per visible cell.
                                const channelPriced = Object.keys(inventory.pricesByOcc[key] ?? {}).some((o) => Number(o) > 0);
                                return (
                                  <td key={d} className={cell(d)}>
                                    <input
                                      name={`p:${suffix}`}
                                      type="number"
                                      min={0}
                                      step="0.01"
                                      defaultValue={inventory.prices[key] ?? ""}
                                      placeholder={base.toFixed(0)}
                                      disabled={channelPriced}
                                      title={channelPriced ? t("invChannelPriced") : undefined}
                                      className={cellInput}
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                            {/* Per-occupancy prices: the real selling prices of a
                                per-person rate, edited exactly like the row above.
                                Restrictions stay per date, not per adult count. */}
                            {occRows.map((occ) => (
                              <tr key={`${rate.id}:${occ}`} hidden={hidden} className="bg-surface-alt/30">
                                <td className={subLabel}>
                                  <span aria-hidden="true" className="mr-1.5">👤</span>
                                  {t(occ === 1 ? "invAdults_one" : "invAdults_other", { n: occ })}
                                </td>
                                {shown.map((d) => {
                                  const { key } = at(d);
                                  const byOcc = inventory.pricesByOcc[key];
                                  // Placeholder = what this cell would charge if
                                  // left blank, so an inherited price is visible
                                  // rather than looking unset. Computed WITHOUT
                                  // this occupancy, which is what deleting it
                                  // leaves behind.
                                  const { [occ]: _own, ...rest } = byOcc ?? {};
                                  const inherited = perPersonPrice(rest, occ) ?? base * occ;
                                  return (
                                    <td key={d} className={cell(d)}>
                                      <input
                                        name={`po:${room.id}:${rid}:${d}:${occ}`}
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        defaultValue={byOcc?.[occ] ?? ""}
                                        placeholder={inherited.toFixed(0)}
                                        title={t("invOccPricesTitle")}
                                        className={cellInput}
                                      />
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                            {/* Restriction rows — one field per row, so every
                                cell holds exactly one thing. */}
                            <tr hidden={hidden || !showRestr}>
                              <td className={subLabel}>{t("invMinStay")}</td>
                              {shown.map((d) => {
                                const { suffix, restr } = at(d);
                                return (
                                  <td key={d} className={cell(d)}>
                                    <input name={`m:${suffix}`} type="number" min={0} defaultValue={restr?.minStay || ""} placeholder="1" title={t("invMinimumStay")} className={cellInput} />
                                  </td>
                                );
                              })}
                            </tr>
                            <tr hidden={hidden || !showRestr}>
                              <td className={subLabel}>{t("invMaxStay")}</td>
                              {shown.map((d) => {
                                const { suffix, restr } = at(d);
                                return (
                                  <td key={d} className={cell(d)}>
                                    <input name={`x:${suffix}`} type="number" min={0} defaultValue={restr?.maxStay || ""} placeholder="∞" title={t("invMaximumStay")} className={cellInput} />
                                  </td>
                                );
                              })}
                            </tr>
                            <tr hidden={hidden || !showRestr}>
                              <td className={subLabel}>{t("invClosed")}</td>
                              {shown.map((d) => {
                                const { suffix, restr } = at(d);
                                return (
                                  <td key={d} className={cell(d)}>
                                    <FlagCell name={`s:${suffix}`} checked={restr?.stopSell} title={t("invClosedStopSell")} danger offLabel={t("invOpen")} onLabel={t("invClosed")} />
                                  </td>
                                );
                              })}
                            </tr>
                            <tr hidden={hidden || !showRestr}>
                              <td className={subLabel}>{t("invNoArrival")}</td>
                              {shown.map((d) => {
                                const { suffix, restr } = at(d);
                                return (
                                  <td key={d} className={cell(d)}>
                                    <FlagCell name={`ca:${suffix}`} checked={restr?.cta} title={t("invClosedToArrival")} offLabel={t("invOpen")} onLabel={t("invClosed")} />
                                  </td>
                                );
                              })}
                            </tr>
                            <tr hidden={hidden || !showRestr} className="border-b border-divider/40">
                              <td className={subLabel}>{t("invNoDeparture")}</td>
                              {shown.map((d) => {
                                const { suffix, restr } = at(d);
                                return (
                                  <td key={d} className={cell(d)}>
                                    <FlagCell name={`cd:${suffix}`} checked={restr?.ctd} title={t("invClosedToDeparture")} offLabel={t("invOpen")} onLabel={t("invClosed")} />
                                  </td>
                                );
                              })}
                            </tr>
                          </Fragment>
                        );
                      })}
                      {roomRates.length === 0 && (
                        <tr hidden={hidden} className="border-t border-divider/60">
                          <td className={labelCell} colSpan={shown.length + 1}>
                            <span className="text-[12px] text-muted-2">{t("invNoRatesForRoom")}</span>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </fieldset>
        <p className="mt-3 text-[12px] text-muted-2">{t("invBaseHint", { currency })}</p>

        {/* Floating save bar: appears only while there is something to save. */}
        {dirty > 0 && !readOnly && (
          <div className="sticky bottom-4 z-20 mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-line bg-surface px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
            <span className="text-[13px] font-semibold text-ink">
              {t(dirty === 1 ? "invUnsaved_one" : "invUnsaved_other", { n: dirty })}
            </span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={discard} className={secondaryBtn}>{t("invDiscard")}</button>
              <button type="submit" disabled={saving} className={primaryBtn}>{saving ? t("saving") : t("saveChanges")}</button>
            </div>
          </div>
        )}
      </Form>

      {/* Leaving with unsaved edits: an in-page prompt rather than a browser
          confirm(), which some embedded views auto-dismiss. */}
      {blocker.state === "blocked" && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4">
          <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-notice-line bg-notice-soft px-4 py-3 text-[13px] text-notice shadow-lg">
            <span className="font-semibold">{t("invLeavePrompt")}</span>
            <button type="button" onClick={() => blocker.reset()} className={secondaryBtn}>{t("invStay")}</button>
            <button type="button" onClick={() => blocker.proceed()} className="rounded-[10px] bg-notice px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90">
              {t("invLeave")}
            </button>
          </div>
        </div>
      )}

      {/* Bulk edit drawer — an editing tool only, never shown read-only. */}
      {bulkOpen && !readOnly && (
        <>
          <button type="button" aria-label={t("invCloseDrawer")} onClick={() => setBulkOpen(false)} className="fixed inset-0 z-30 bg-ink/30" />
          <aside
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-title"
            className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[440px] flex-col bg-surface shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-divider px-5 py-4">
              <h2 id="bulk-title" className="font-serif text-[18px] font-semibold">{t("invBulkEdit")}</h2>
              <button type="button" onClick={() => setBulkOpen(false)} aria-label={t("invCloseDrawer")} className={toolBtn}>✕</button>
            </div>
            <Form method="post" className="flex min-h-0 flex-1 flex-col">
              <input type="hidden" name="intent" value="bulk" />
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                <section>
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-2">{t("invDates")}</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className={bulkLabel}>{t("invFrom")}</span>
                      <input type="date" name="from" defaultValue={start} required className={`${bulkField} w-full`} />
                    </label>
                    <label className="block">
                      <span className={bulkLabel}>{t("invTo")}</span>
                      <input type="date" name="to" defaultValue={format(addDays(parseISO(start), 13), "yyyy-MM-dd")} required className={`${bulkField} w-full`} />
                    </label>
                  </div>
                  <div className="mt-3">
                    <span className={bulkLabel}>{t("invDaysOfWeek")}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {DOW.map((d) => (
                        <label key={d.v} className="cursor-pointer">
                          <input type="checkbox" name="dow" value={d.v} defaultChecked className="peer sr-only" />
                          <span className="inline-block rounded-[8px] border border-line-alt px-2.5 py-1.5 text-[12px] font-semibold text-muted-2 peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent-deep peer-focus-visible:ring-2 peer-focus-visible:ring-accent-soft-strong">
                            {t(d.labelKey)}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-2">{t("invApplyTo")}</h3>
                  <div className="grid grid-cols-2 gap-3">
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
                </section>

                <section>
                  <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-muted-2">{t("invSetValues")}</h3>
                  <p className="mb-3 text-[12px] text-muted-2">{t("invBulkHint")}</p>
                  <div className="grid grid-cols-2 gap-3">
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
                      <span className={bulkLabel}>{t("invMaxStay")}</span>
                      <input type="number" name="maxStay" min={0} placeholder={t("invLeaveBlank")} className={`${bulkField} w-full`} />
                    </label>
                  </div>
                  <div className="mt-3 space-y-3">
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
                </section>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-divider px-5 py-4">
                {actionData?.error && !actionData?.ok ? (
                  <span className="text-[12px] text-danger">{actionData.error}</span>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setBulkOpen(false)} className={secondaryBtn}>{t("invCloseDrawer")}</button>
                  <button type="submit" disabled={saving} className={primaryBtn}>
                    {saving ? t("invApplying") : t("invApplyToRange")}
                  </button>
                </div>
              </div>
            </Form>
          </aside>
        </>
      )}
    </div>
  );
}
