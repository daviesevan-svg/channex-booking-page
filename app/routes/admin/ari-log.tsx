import { useEffect, useState } from "react";
import { Form, useSearchParams } from "react-router";

import type { Route } from "./+types/ari-log";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getRates, getRooms, rateChannexId } from "~/lib/catalog.server";
import { queryAriLog } from "~/lib/ari.server";
import { useAdminT, type AdminT } from "~/lib/admin-i18n";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const url = new URL(request.url);
  const date = ISO_DATE.test(url.searchParams.get("date") ?? "") ? url.searchParams.get("date")! : "";
  const room = url.searchParams.get("room") ?? "";
  const rate = url.searchParams.get("rate") ?? "";

  const [rooms, rates] = await Promise.all([getRooms(propertyId), getRates(propertyId)]);

  // Log ids are Channex ids. Build name maps that resolve both catalog ids and
  // the per-room Channex rate ids a consolidated plan maps to.
  const roomName = new Map(rooms.map((r) => [r.id, r.title]));
  const rateName = new Map<string, string>();
  for (const r of rates) {
    rateName.set(r.id, r.title);
    for (const room of rooms) rateName.set(rateChannexId(r, room.id), r.title);
  }

  // Selected rate → all the Channex ids it could appear under in the log.
  const selectedRate = rates.find((r) => r.id === rate);
  const ratePlanIds = selectedRate
    ? [...new Set([selectedRate.id, ...rooms.map((rm) => rateChannexId(selectedRate, rm.id))])]
    : undefined;

  const rows = await queryAriLog(propertyId, {
    date: date || undefined,
    roomTypeId: room || undefined,
    ratePlanIds,
    limit: 300,
  });

  return {
    configured: true as const,
    rows: rows.map((r) => ({
      ...r,
      roomLabel: roomName.get(r.roomTypeId) ?? r.roomTypeId,
      rateLabel: r.ratePlanId ? rateName.get(r.ratePlanId) ?? r.ratePlanId : null,
    })),
    rooms: rooms.map((r) => ({ id: r.id, title: r.title })),
    rates: rates.map((r) => ({ id: r.id, title: r.title })),
    filters: { date, room, rate },
  };
}

export function meta() {
  return [{ title: "Admin · Change log" }];
}

const FIELD_LABEL: Record<string, string> = {
  avail: "alFieldAvail",
  price: "alFieldPrice",
  stop_sell: "alFieldStopSell",
  min_stay: "alFieldMinStay",
  cta: "alFieldCta",
  ctd: "alFieldCtd",
};

function fmtValue(field: string, v: string | null, t: AdminT): string {
  if (v == null || v === "") return "—";
  if (field === "stop_sell" || field === "cta" || field === "ctd") return v === "true" ? t("alYes") : t("alNo");
  return v;
}

/** Change timestamp, formatted in the operator's browser timezone/locale. */
function When({ ts }: { ts: number }) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText(new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  }, [ts]);
  return <span suppressHydrationWarning>{text || "…"}</span>;
}

export default function AriLog({ loaderData }: Route.ComponentProps) {
  const [, setSearchParams] = useSearchParams();
  const t = useAdminT();

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("alTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("alNotConfigured")}</p>
      </div>
    );
  }

  const { rows, rooms, rates, filters } = loaderData;
  const hasFilter = Boolean(filters.date || filters.room || filters.rate);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{t("alTitle")}</h1>
      </div>
      <p className="mb-5 max-w-2xl text-[14px] text-secondary">{t("alIntro")}</p>

      <Form
        method="get"
        className="mb-5 flex flex-wrap items-end gap-3 rounded-[12px] border border-line bg-surface p-4"
      >
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-secondary">
          {t("alAffectedDate")}
          <input
            type="date"
            name="date"
            defaultValue={filters.date}
            className="rounded-[9px] border border-line-alt bg-surface px-3 py-2 text-[14px] font-normal text-ink outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-secondary">
          {t("alRoom")}
          <select
            name="room"
            defaultValue={filters.room}
            className="min-w-[160px] rounded-[9px] border border-line-alt bg-surface px-3 py-2 text-[14px] font-normal text-ink outline-none focus:border-accent"
          >
            <option value="">{t("alAllRooms")}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-secondary">
          {t("alRatePlan")}
          <select
            name="rate"
            defaultValue={filters.rate}
            className="min-w-[160px] rounded-[9px] border border-line-alt bg-surface px-3 py-2 text-[14px] font-normal text-ink outline-none focus:border-accent"
          >
            <option value="">{t("alAllRates")}</option>
            {rates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-[9px] bg-accent px-5 py-2 text-[14px] font-semibold text-white hover:bg-accent-deep"
        >
          {t("alSearch")}
        </button>
        {hasFilter && (
          <button
            type="button"
            onClick={() => setSearchParams({})}
            className="rounded-[9px] border border-line-alt bg-surface px-4 py-2 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent"
          >
            {t("alClear")}
          </button>
        )}
      </Form>

      <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
        <table className="w-full min-w-[760px] border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-divider text-left text-[11.5px] font-semibold uppercase tracking-wider text-faint">
              <th className="px-4 py-3">{t("alColWhen")}</th>
              <th className="px-4 py-3">{t("alColWho")}</th>
              <th className="px-4 py-3">{t("alRoom")}</th>
              <th className="px-4 py-3">{t("alColRate")}</th>
              <th className="px-4 py-3">{t("alAffectedDate")}</th>
              <th className="px-4 py-3">{t("alColWhat")}</th>
              <th className="px-4 py-3">{t("alColChange")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-[14px] text-muted">
                  {t(hasFilter ? "alNoChangesFilter" : "alNoChangesYet")}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-divider last:border-0">
                <td className="whitespace-nowrap px-4 py-3 text-secondary">
                  <When ts={r.ts} />
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span
                    className={`mr-2 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      r.source === "channex"
                        ? "bg-chip text-muted"
                        : "bg-[#e8f0e6] text-[#3f7a52]"
                    }`}
                  >
                    {r.source === "channex" ? "Channex" : t("alSourceUser")}
                  </span>
                  {r.source === "user" ? r.actor : ""}
                </td>
                <td className="px-4 py-3">{r.roomLabel}</td>
                <td className="px-4 py-3 text-secondary">{r.rateLabel ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-secondary">{r.date}</td>
                <td className="whitespace-nowrap px-4 py-3 font-semibold">{FIELD_LABEL[r.field] ? t(FIELD_LABEL[r.field]) : r.field}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span className="text-muted line-through">{fmtValue(r.field, r.oldValue, t)}</span>
                  <span className="mx-1.5 text-faint">→</span>
                  <span className="font-semibold text-ink">{fmtValue(r.field, r.newValue, t)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length >= 300 && (
        <p className="mt-3 text-[12.5px] text-muted">{t("alShowingLimit")}</p>
      )}
    </div>
  );
}
