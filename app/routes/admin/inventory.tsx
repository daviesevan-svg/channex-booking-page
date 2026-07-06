import { useEffect, useRef, useState } from "react";
import { addDays, format, parseISO } from "date-fns";
import { Form, Link, useNavigate, useNavigation } from "react-router";

import type { Route } from "./+types/inventory";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getRates, getRooms } from "~/lib/catalog.server";
import { applyBulkUpdate, getInventory, saveInventory, type AriActor, type InventoryEdits } from "~/lib/ari.server";
import { getSettings } from "~/lib/overrides.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";

// Generous server window; the client renders only as many columns as fit the
// screen and pages by that visible count.
const FETCH_DAYS = 31;
const DEFAULT_COLS = 14;

// Day-of-week chips for bulk update. Values are getUTCDay() codes (0 = Sunday).
const DOW = [
  { v: 1, label: "Mon" },
  { v: 2, label: "Tue" },
  { v: 3, label: "Wed" },
  { v: 4, label: "Thu" },
  { v: 5, label: "Fri" },
  { v: 6, label: "Sat" },
  { v: 0, label: "Sun" },
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

  return {
    configured: true as const,
    rooms: rooms.map((r) => ({ id: r.id, title: r.title })),
    rates: rates.map((r) => ({ id: r.id, title: r.title, prices: r.prices })),
    currency: settings.currency || "GBP",
    dates,
    start,
    inventory,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const email = await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
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
      rates: scopedRates.map((r) => ({ id: r.id, prices: r.prices })),
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
      // price: p:roomId:rateId:date
      const [, roomId, rateId, date] = parts;
      if (!date || v === "") continue;
      const price = Math.round(Number(v) * 100) / 100;
      if (price > 0) edits.prices.push({ roomId, rateId, date, price });
    }
  }
  // Restrictions cover every (room, its rates) × date in the window so toggles
  // clear too. A rate is offered on a room only when it has a price for it.
  for (const rate of rates) {
    for (const roomId of Object.keys(rate.prices)) {
      for (const date of dates) {
        const suffix = `${roomId}:${rate.id}:${date}`;
        edits.restrictions.push({
          rateId: rate.id,
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

export function meta() {
  return [{ title: "Admin · Inventory" }];
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
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Inventory</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to manage
          inventory.
        </p>
      </div>
    );
  }

  const { rooms, rates, currency, dates, start, inventory } = loaderData;
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
        <h1 className="mb-1 font-serif text-[26px] font-semibold">Inventory</h1>
        <div className="mt-4 rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          Create a <Link to="/admin/rooms/new" className="font-semibold text-accent">room</Link> and a
          rate first, then set availability and prices here.
        </div>
      </div>
    );
  }

  const headCell = "sticky top-0 z-10 bg-surface-alt px-2 py-2 text-center text-[12px] font-semibold";
  const labelCell = "sticky left-0 z-10 bg-surface px-3 py-2 text-left text-[13px]";

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[26px] font-semibold">Inventory</h1>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <input
            type="date"
            value={start}
            onChange={(e) => e.target.value && go(e.target.value)}
            aria-label="Jump to date"
            className="rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-ink outline-none focus:border-accent"
          />
          <button type="button" onClick={() => go(today)} className="rounded-[8px] border border-line-alt px-2.5 py-1.5 hover:border-accent hover:text-accent">
            Today
          </button>
          <button type="button" onClick={() => go(prevStart)} aria-label="Previous dates" className="rounded-[8px] border border-line-alt px-2.5 py-1.5 hover:border-accent hover:text-accent">←</button>
          <span className="text-muted-2">
            {format(parseISO(shown[0]), "d MMM")} – {format(parseISO(shown[shown.length - 1]), "d MMM yyyy")}
          </span>
          <button type="button" onClick={() => go(nextStart)} aria-label="Next dates" className="rounded-[8px] border border-line-alt px-2.5 py-1.5 hover:border-accent hover:text-accent">→</button>
        </div>
      </div>
      <p className="mb-5 text-[14px] text-muted">
        Availability per room, and price + restrictions per rate, for each date. Empty price uses the
        rate&rsquo;s base nightly price. Prices in {currency}. Per cell: minimum stay,{" "}
        <span className="font-semibold text-[#c0392b]">✕</span> closed,{" "}
        <span className="font-semibold text-accent">A</span> no arrival,{" "}
        <span className="font-semibold text-accent">D</span> no departure.
      </p>

      <div className="mb-5 rounded-[14px] border border-line bg-surface">
        <button
          type="button"
          onClick={() => setBulkOpen((v) => !v)}
          aria-expanded={bulkOpen}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="font-serif text-[16px] font-semibold">Bulk update</span>
          <span className="text-[13px] font-semibold text-muted-2">
            {bulkOpen ? "Hide ▲" : "Set a range of dates ▼"}
          </span>
        </button>
        {bulkOpen && (
          <Form method="post" className="space-y-4 border-t border-divider px-4 py-4">
            <input type="hidden" name="intent" value="bulk" />

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className={bulkLabel}>From</span>
                <input type="date" name="from" defaultValue={start} required className={`${bulkField} w-full`} />
              </label>
              <label className="block">
                <span className={bulkLabel}>To</span>
                <input
                  type="date"
                  name="to"
                  defaultValue={format(addDays(parseISO(start), 13), "yyyy-MM-dd")}
                  required
                  className={`${bulkField} w-full`}
                />
              </label>
              <label className="block">
                <span className={bulkLabel}>Room</span>
                <select name="room" defaultValue="all" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="all">All rooms</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>{r.title}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={bulkLabel}>Rate</span>
                <select name="rate" defaultValue="all" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="all">All rates</option>
                  {rates.map((r) => (
                    <option key={r.id} value={r.id}>{r.title}</option>
                  ))}
                </select>
              </label>
            </div>

            <div>
              <span className={bulkLabel}>Days of week</span>
              <div className="flex flex-wrap gap-1.5">
                {DOW.map((d) => (
                  <label key={d.v} className="cursor-pointer">
                    <input type="checkbox" name="dow" value={d.v} defaultChecked className="peer sr-only" />
                    <span className="inline-block rounded-[8px] border border-line-alt px-3 py-1.5 text-[12px] font-semibold text-muted-2 peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent-deep">
                      {d.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className={bulkLabel}>Availability</span>
                <input type="number" name="avail" min={0} placeholder="Leave blank" className={`${bulkField} w-full`} />
              </label>
              <label className="block">
                <span className={bulkLabel}>Price ({currency})</span>
                <input type="number" name="price" min={0} step="0.01" placeholder="Leave blank" className={`${bulkField} w-full`} />
              </label>
              <label className="block">
                <span className={bulkLabel}>Min stay</span>
                <input type="number" name="minStay" min={0} placeholder="Leave blank" className={`${bulkField} w-full`} />
              </label>
              <label className="block">
                <span className={bulkLabel}>Closed / stop sell</span>
                <select name="stopSell" defaultValue="" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="">Leave unchanged</option>
                  <option value="on">Close (stop sell)</option>
                  <option value="off">Open</option>
                </select>
              </label>
              <label className="block">
                <span className={bulkLabel}>No arrival (CTA)</span>
                <select name="cta" defaultValue="" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="">Leave unchanged</option>
                  <option value="on">No check-in</option>
                  <option value="off">Allow check-in</option>
                </select>
              </label>
              <label className="block">
                <span className={bulkLabel}>No departure (CTD)</span>
                <select name="ctd" defaultValue="" className={`${bulkField} w-full cursor-pointer`}>
                  <option value="">Leave unchanged</option>
                  <option value="on">No check-out</option>
                  <option value="off">Allow check-out</option>
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
              >
                {saving ? "Applying…" : "Apply to range"}
              </button>
              <p className="text-[12px] text-muted-2">
                Blank fields are left untouched. Availability applies per room; price and restrictions
                apply per selected rate.
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
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {actionData?.ok && (
            <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
              ✓ {actionData.message ?? "Saved"}
            </span>
          )}
          {actionData?.error && <span className="text-[13px] text-red-600">{actionData.error}</span>}
          <div className="ml-auto flex items-center gap-2 text-[13px] font-semibold">
            <label htmlFor="roomFilter" className="text-muted-2">Show</label>
            <select
              id="roomFilter"
              value={roomFilter}
              onChange={(e) => setRoomFilter(e.target.value)}
              className="cursor-pointer rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-ink outline-none focus:border-accent"
            >
              <option value="all">All rooms</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.title}</option>
              ))}
            </select>
          </div>
        </div>

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
                    {roomRates.length} rate{roomRates.length === 1 ? "" : "s"}
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
                          <div>{format(parseISO(d), "EEE")}</div>
                          <div className="text-[13px] font-bold text-ink">{format(parseISO(d), "d")}</div>
                          <div className="text-[10px] font-normal text-faint">{format(parseISO(d), "MMM")}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Room availability row */}
                    <tr className="border-t border-divider bg-surface-alt/40">
                      <td className={`${labelCell} bg-surface-alt/40 font-semibold`}>
                        Availability
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
                    {roomRates.map((rate) => (
                      <tr key={rate.id} className="border-t border-divider/60">
                        <td className={labelCell}>
                          <div className="font-medium">{rate.title}</div>
                          <div className="text-[11px] text-muted-2">Price · min stay · ✕ A D</div>
                        </td>
                        {shown.map((d) => {
                          const key = `${room.id}|${rate.id}|${d}`;
                          const suffix = `${room.id}:${rate.id}:${d}`;
                          const restr = inventory.restrictions[key];
                          return (
                            <td key={d} className={`px-1.5 py-1.5 align-top ${isWeekend(d) ? "bg-field-hover/40" : ""}`}>
                              <input
                                name={`p:${suffix}`}
                                type="number"
                                min={0}
                                step="0.01"
                                defaultValue={inventory.prices[key] ?? ""}
                                placeholder={rate.prices[room.id].toFixed(0)}
                                className={cellInput}
                              />
                              <div className="mt-1 flex items-center justify-center gap-1">
                                <input
                                  name={`m:${suffix}`}
                                  type="number"
                                  min={0}
                                  defaultValue={restr?.minStay || ""}
                                  title="Minimum stay"
                                  placeholder="0"
                                  className="w-8 rounded-[6px] border border-line-alt bg-surface px-1 py-0.5 text-center text-[11px] outline-none focus:border-accent"
                                />
                                <Toggle name={`s:${suffix}`} label="✕" title="Closed / stop sell" checked={restr?.stopSell} danger />
                                <Toggle name={`ca:${suffix}`} label="A" title="Closed to arrival (no check-in)" checked={restr?.cta} />
                                <Toggle name={`cd:${suffix}`} label="D" title="Closed to departure (no check-out)" checked={restr?.ctd} />
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {roomRates.length === 0 && (
                      <tr className="border-t border-divider/60">
                        <td className={labelCell} colSpan={shown.length + 1}>
                          <span className="text-[12px] text-muted-2">
                            No rates priced for this room yet.
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
      </Form>
    </div>
  );
}
