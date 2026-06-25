import { addDays, format, parseISO } from "date-fns";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/inventory";
import { requireAdmin } from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";
import { getRates, getRooms } from "~/lib/catalog.server";
import { getInventory, saveInventory, type InventoryEdits } from "~/lib/ari.server";
import { getSettings } from "~/lib/overrides.server";

const WINDOW = 14; // days shown at once

function windowDates(start: string): string[] {
  const base = parseISO(start);
  return Array.from({ length: WINDOW }, (_, i) => format(addDays(base, i), "yyyy-MM-dd"));
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { configured: false as const };

  const url = new URL(request.url);
  const start = url.searchParams.get("start") || format(new Date(), "yyyy-MM-dd");
  const dates = windowDates(start);
  const [rooms, rates, settings, inventory] = await Promise.all([
    getRooms(propertyId),
    getRates(propertyId),
    getSettings(propertyId),
    getInventory(propertyId, dates[0], dates[dates.length - 1]),
  ]);

  return {
    configured: true as const,
    rooms: rooms.map((r) => ({ id: r.id, title: r.title })),
    rates: rates.map((r) => ({ id: r.id, roomId: r.roomId, title: r.title, nightlyPrice: r.nightlyPrice })),
    currency: settings.currency || "GBP",
    dates,
    start,
    prevStart: format(addDays(parseISO(start), -WINDOW), "yyyy-MM-dd"),
    nextStart: format(addDays(parseISO(start), WINDOW), "yyyy-MM-dd"),
    inventory,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };

  const form = await request.formData();
  const start = String(form.get("start") || format(new Date(), "yyyy-MM-dd"));
  const dates = windowDates(start);
  const rateRoom = new Map((await getRates(propertyId)).map((r) => [r.id, r.roomId]));
  const settings = await getSettings(propertyId);

  const edits: InventoryEdits = {
    currency: settings.currency || "GBP",
    availability: [],
    prices: [],
    restrictions: [],
  };

  for (const [key, value] of form.entries()) {
    const v = String(value).trim();
    const [kind, a, date] = key.split(":");
    if (!date) continue;
    if (kind === "a" && v !== "") {
      edits.availability.push({ roomId: a, date, avail: Math.max(0, Math.round(Number(v)) || 0) });
    } else if (kind === "p" && v !== "") {
      const price = Math.round(Number(v) * 100) / 100;
      if (price > 0) edits.prices.push({ rateId: a, roomId: rateRoom.get(a) ?? "", date, price });
    }
  }
  // Restrictions cover every rate × date in the window so toggles clear too.
  const rates = [...rateRoom.keys()];
  for (const rateId of rates) {
    for (const date of dates) {
      edits.restrictions.push({
        rateId,
        roomId: rateRoom.get(rateId) ?? "",
        date,
        stopSell: form.get(`s:${rateId}:${date}`) != null,
        minStay: Math.max(0, Math.round(Number(form.get(`m:${rateId}:${date}`)) || 0)),
        cta: form.get(`ca:${rateId}:${date}`) != null,
        ctd: form.get(`cd:${rateId}:${date}`) != null,
      });
    }
  }

  await saveInventory(propertyId, edits);
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Inventory" }];
}

const cellInput =
  "w-full rounded-[6px] border border-line-alt bg-surface px-1.5 py-1 text-center text-[13px] text-ink outline-none focus:border-accent";

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
  const saving = nav.state === "submitting";

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

  const { rooms, rates, currency, dates, start, prevStart, nextStart, inventory } = loaderData;
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
          <Link to={`/admin/inventory?start=${prevStart}`} className="rounded-[8px] border border-line-alt px-2.5 py-1.5 hover:border-accent hover:text-accent">←</Link>
          <span className="text-muted-2">
            {format(parseISO(dates[0]), "d MMM")} – {format(parseISO(dates[dates.length - 1]), "d MMM yyyy")}
          </span>
          <Link to={`/admin/inventory?start=${nextStart}`} className="rounded-[8px] border border-line-alt px-2.5 py-1.5 hover:border-accent hover:text-accent">→</Link>
        </div>
      </div>
      <p className="mb-5 text-[14px] text-muted">
        Availability per room, and price + restrictions per rate, for each date. Empty price uses the
        rate&rsquo;s base nightly price. Prices in {currency}. Per cell: minimum stay,{" "}
        <span className="font-semibold text-[#c0392b]">✕</span> closed,{" "}
        <span className="font-semibold text-accent">A</span> no arrival,{" "}
        <span className="font-semibold text-accent">D</span> no departure.
      </p>

      <Form method="post">
        <input type="hidden" name="start" value={start} />
        <div className="mb-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {actionData?.ok && (
            <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">✓ Saved</span>
          )}
          {actionData?.error && <span className="text-[13px] text-red-600">{actionData.error}</span>}
        </div>

        <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
          <table className="border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={`${labelCell} ${headCell} min-w-[200px]`} />
                {dates.map((d) => (
                  <th key={d} className={`${headCell} min-w-[96px] ${isWeekend(d) ? "text-accent" : "text-muted-2"}`}>
                    <div>{format(parseISO(d), "EEE")}</div>
                    <div className="text-[13px] font-bold text-ink">{format(parseISO(d), "d")}</div>
                    <div className="text-[10px] font-normal text-faint">{format(parseISO(d), "MMM")}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => {
                const roomRates = rates.filter((r) => r.roomId === room.id);
                return (
                  <>
                    {/* Room availability row */}
                    <tr key={room.id} className="border-t border-divider bg-surface-alt/40">
                      <td className={`${labelCell} bg-surface-alt/40 font-semibold`}>
                        {room.title}
                        <div className="text-[11px] font-normal text-muted-2">Availability</div>
                      </td>
                      {dates.map((d) => (
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
                        {dates.map((d) => {
                          const restr = inventory.restrictions[`${rate.id}|${d}`];
                          return (
                            <td key={d} className={`px-1.5 py-1.5 align-top ${isWeekend(d) ? "bg-field-hover/40" : ""}`}>
                              <input
                                name={`p:${rate.id}:${d}`}
                                type="number"
                                min={0}
                                step="0.01"
                                defaultValue={inventory.prices[`${rate.id}|${d}`] ?? ""}
                                placeholder={rate.nightlyPrice.toFixed(0)}
                                className={cellInput}
                              />
                              <div className="mt-1 flex items-center justify-center gap-1">
                                <input
                                  name={`m:${rate.id}:${d}`}
                                  type="number"
                                  min={0}
                                  defaultValue={restr?.minStay || ""}
                                  title="Minimum stay"
                                  placeholder="0"
                                  className="w-8 rounded-[6px] border border-line-alt bg-surface px-1 py-0.5 text-center text-[11px] outline-none focus:border-accent"
                                />
                                <Toggle name={`s:${rate.id}:${d}`} label="✕" title="Closed / stop sell" checked={restr?.stopSell} danger />
                                <Toggle name={`ca:${rate.id}:${d}`} label="A" title="Closed to arrival (no check-in)" checked={restr?.cta} />
                                <Toggle name={`cd:${rate.id}:${d}`} label="D" title="Closed to departure (no check-out)" checked={restr?.ctd} />
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </Form>
    </div>
  );
}
