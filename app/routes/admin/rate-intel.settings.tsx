import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/rate-intel.settings";
import { FeatureUnavailable } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { getRevmanState } from "~/lib/revman.server";
import { getCaptureSettings, setCaptureSettings } from "~/lib/revman-comp-capture.server";
import { getCompSet } from "~/lib/revman-compset.server";
import { getBalance } from "~/lib/revman-tokens.server";
import { getRooms } from "~/lib/catalog.server";
import { explainDirectCompare, getCompareSettings, ownOtaRooms, setCompareSettings } from "~/lib/direct-compare.server";
import type { CompareExplain } from "~/lib/direct-compare.server";
import { formatMoney } from "~/lib/money";
import { importBookingRoomMap } from "~/lib/channex/bcom-mapping.server";
import { suggestRoomMap } from "~/lib/direct-compare";
import { todayISODate } from "~/lib/dates";
import { useAdminT } from "~/lib/admin-i18n";

const DAY = 86_400_000;
const isoAt = (base: string, add: number) =>
  new Date(Date.parse(`${base}T00:00:00Z`) + add * DAY).toISOString().slice(0, 10);

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { configured: false as const };
  // Part of revenue management — not available to single-unit rentals.
  if ((await getSettings(pid)).singleUnit === true)
    return { configured: true as const, singleUnit: true as const, connected: false as const };
  const state = await getRevmanState(pid);
  if (!state) return { configured: true as const, singleUnit: false as const, connected: false as const };
  const today = todayISODate();
  const [settings, balance, set, compare, ourRooms, otaRooms] = await Promise.all([
    getCaptureSettings(pid),
    getBalance(pid),
    getCompSet(pid),
    getCompareSettings(pid),
    getRooms(pid),
    // A wide window so the picker still lists rooms when only far-out dates have
    // been captured so far.
    ownOtaRooms(pid, today, isoAt(today, 365)),
  ]);
  const hotelCount = set.ranked.filter((h) => Boolean(h.bookingRef)).length;
  // Pre-select by name for any room the owner hasn't mapped yet — a suggestion to
  // confirm, never applied on its own.
  const suggested = suggestRoomMap(
    ourRooms.filter((r) => !compare.roomMap[r.id]).map((r) => ({ id: r.id, title: r.title })),
    otaRooms.filter((o) => !Object.values(compare.roomMap).includes(o.roomRef)),
  );
  return {
    configured: true as const,
    singleUnit: false as const,
    connected: true as const,
    settings,
    balance,
    hotelCount,
    compare,
    ourRooms: ourRooms.map((r) => ({ id: r.id, title: r.title })),
    otaRooms,
    suggested,
  };
}

export function meta() {
  return [{ title: "Admin · Rate intelligence settings" }];
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { error: "Select a property first." };
  const form = await request.formData();

  if (String(form.get("intent")) === "compareCheck") {
    const checkin = String(form.get("checkDate") ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin)) return { checkError: true as const };
    const explain = await explainDirectCompare(pid, {
      checkin,
      nights: Number(form.get("checkNights")) || 1,
      adults: Number(form.get("checkAdults")) || 2,
    });
    return { explain, checkin };
  }

  if (String(form.get("intent")) === "compareImport") {
    // Read-only pull of the property's Booking.com channel mapping. Presented for
    // review — the owner still has to save the form for it to take effect.
    const today = todayISODate();
    const known = await ownOtaRooms(pid, today, isoAt(today, 365));
    // Honour a hotel id typed in the form but not yet saved, so the owner can pin
    // the connection and import in one go.
    const pinned = String(form.get("bookingHotelId") ?? "").trim();
    const imported = await importBookingRoomMap(pid, known.map((r) => r.roomRef), pinned || undefined);
    return { imported };
  }

  if (String(form.get("intent")) === "compare") {
    // Each room's Booking counterpart arrives as map:<ourRoomId>; an empty value
    // means "don't compare this room", which must clear a previous mapping.
    const roomMap: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (!key.startsWith("map:")) continue;
      const ref = String(value).trim();
      if (ref) roomMap[key.slice(4)] = ref;
    }
    await setCompareSettings(pid, {
      enabled: form.get("compareEnabled") === "on",
      roomMap,
      bookingHotelId: String(form.get("bookingHotelId") ?? ""),
      minSavingPct: Number(form.get("minSavingPct")),
      maxAgeHours: Number(form.get("maxAgeHours")),
    });
    return { okKey: "riCompareSaved" as const };
  }

  await setCaptureSettings(pid, {
    enabled: form.get("enabled") === "on",
    horizonDays: Number(form.get("horizonDays")),
    nearDays: Number(form.get("nearDays")),
    farCadenceDays: Number(form.get("farCadenceDays")),
  });
  return { okKey: "riSaved" as const };
}

const FIELD = "rounded-[9px] border border-line-alt bg-surface px-3 py-2 text-[14px]";

export default function RateIntelSettings({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  if (loaderData.configured && loaderData.singleUnit)
    return <FeatureUnavailable title={t("revSingleUnitTitle")} body={t("revSingleUnitBody")} />;
  if (!loaderData.configured || !loaderData.connected) {
    return (
      <div>
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("riSettingsTitle")}</h1>
        <p className="text-[14px] text-muted">
          {t("riConnectPrefix")}{" "}
          <Link to="/admin/revenue" className="text-accent underline">{t("navRevenue")}</Link>.
        </p>
      </div>
    );
  }

  const { settings, hotelCount } = loaderData;
  // Rough monthly burn: (near dates daily + far dates every farCadence) × hotels
  // priced (one token per hotel per day).
  const far = Math.max(0, settings.horizonDays - settings.nearDays);
  const perHotel = settings.nearDays * 30 + (far / settings.farCadenceDays) * 30;
  const monthlyTokens = Math.round(perHotel * Math.max(1, hotelCount));

  return (
    <div className="max-w-[640px]">
      <div className="mb-1 text-[13px]">
        <Link to="/admin/rate-intel" className="text-accent hover:underline">← {t("riBack")}</Link>
      </div>
      <h1 className="font-serif text-[26px] font-semibold">{t("riSettingsTitle")}</h1>
      <p className="mt-1 text-[13.5px] text-muted">{t("riSettingsSub")}</p>

      {actionData && "okKey" in actionData && actionData.okKey && (
        <p className="mt-4 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-800">{t(actionData.okKey)}</p>
      )}

      <Form method="post" className="mt-5 flex flex-col gap-5">
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <label className="flex items-center gap-3">
            <input type="checkbox" name="enabled" defaultChecked={settings.enabled} className="h-4 w-4" />
            <span>
              <span className="text-[14px] font-semibold">{t("riSetEnabled")}</span>
              <span className="block text-[12.5px] text-muted">{t("riSetEnabledSub")}</span>
            </span>
          </label>

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="text-[13px] font-medium text-secondary">
              {t("riSetHorizon")}
              <select name="horizonDays" defaultValue={String(settings.horizonDays)} className={`${FIELD} mt-1 block w-full`}>
                <option value="30">{t("riDays", { n: "30" })}</option>
                <option value="60">{t("riDays", { n: "60" })}</option>
                <option value="90">{t("riDays", { n: "90" })}</option>
                <option value="180">{t("riDays", { n: "180" })}</option>
                <option value="365">{t("riDays", { n: "365" })}</option>
              </select>
              <span className="mt-1 block text-[12px] text-muted">{t("riSetHorizonSub")}</span>
            </label>

            <label className="text-[13px] font-medium text-secondary">
              {t("riSetNear")}
              <input type="number" name="nearDays" min={1} max={365} defaultValue={settings.nearDays} className={`${FIELD} mt-1 block w-full`} />
              <span className="mt-1 block text-[12px] text-muted">{t("riSetNearSub")}</span>
            </label>

            <label className="text-[13px] font-medium text-secondary">
              {t("riSetFar")}
              <select name="farCadenceDays" defaultValue={String(settings.farCadenceDays)} className={`${FIELD} mt-1 block w-full`}>
                <option value="1">{t("riCadDaily")}</option>
                <option value="7">{t("riCadWeekly")}</option>
                <option value="14">{t("riCadBiweekly")}</option>
                <option value="30">{t("riCadMonthly")}</option>
              </select>
              <span className="mt-1 block text-[12px] text-muted">{t("riSetFarSub")}</span>
            </label>
          </div>

          <div className="mt-4 rounded-[10px] bg-chip/50 px-4 py-3 text-[13px]">
            <span className="text-muted">{t("riEstBurn")}:</span>{" "}
            <span className="font-semibold tabular-nums">{t("riEstBurnVal", { n: monthlyTokens.toLocaleString() })}</span>
            <span className="ml-1 text-muted">({t("riEstBurnNote")})</span>
          </div>
        </section>

        {/* Future settings live here (alerts, currency, LOS, guest mix, …). */}
        <section className="rounded-[14px] border border-dashed border-line-alt bg-surface p-6 text-[13px] text-muted">
          <div className="font-semibold text-secondary">{t("riFutureTitle")}</div>
          <p className="mt-1">{t("riFutureSub")}</p>
        </section>

        <div>
          <button type="submit" disabled={busy} className="rounded-[10px] bg-accent px-6 py-2.5 text-[14px] font-semibold text-white disabled:opacity-60">
            {t("riSave")}
          </button>
        </div>
      </Form>

      <DirectCompare
        compare={loaderData.compare}
        ourRooms={loaderData.ourRooms}
        otaRooms={loaderData.otaRooms}
        suggested={loaderData.suggested}
        imported={actionData && "imported" in actionData ? actionData.imported : undefined}
        explain={actionData && "explain" in actionData ? actionData.explain : undefined}
        checkin={actionData && "checkin" in actionData ? actionData.checkin : undefined}
        checkError={actionData && "checkError" in actionData ? actionData.checkError : undefined}
        busy={busy}
      />
    </div>
  );
}

/** Settings for the "cheaper direct" badge on the booking page. Separate form
 *  from the capture settings above so saving one never rewrites the other. */
/** Per-room verdict for one stay: what the booking page would do, and why. */
function CheckResult({ explain }: { explain: CompareExplain }) {
  const t = useAdminT();
  const money = (minor: number | null) => (minor == null ? "—" : formatMoney(minor / 100, explain.currency));
  const reason = (row: CompareExplain["rows"][number]): string => {
    if (row.savingPct !== undefined) return t("riCompareWhyShown", { pct: String(row.savingPct) });
    const key = ({
      unmapped: "riCompareWhyUnmapped",
      no_rate: "riCompareWhyNoRate",
      no_capture: "riCompareWhyNoCapture",
      stay_not_sold: "riCompareWhyStayNotSold",
      stale: "riCompareWhyStale",
      currency_mismatch: "riCompareWhyCurrency",
      not_all_in: "riCompareWhyNotAllIn",
      not_cheaper: "riCompareWhyNotCheaper",
      below_threshold: "riCompareWhyBelowThreshold",
    } as const)[row.skip ?? "no_capture"];
    return t(key, { pct: String(explain.minSavingPct), hours: String(explain.maxAgeHours) });
  };

  return (
    <div className="mt-4">
      {!explain.enabled && (
        <p className="mb-2 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
          {t("riCompareWhyDisabled")}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line-alt text-left text-muted">
              <th className="py-1.5 pr-3 font-medium">{t("riCompareWhyRoom")}</th>
              <th className="py-1.5 pr-3 text-right font-medium">{t("riCompareWhyDirect")}</th>
              <th className="py-1.5 pr-3 text-right font-medium">{t("riCompareWhyBooking")}</th>
              <th className="py-1.5 font-medium">{t("riCompareWhyVerdict")}</th>
            </tr>
          </thead>
          <tbody>
            {explain.rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-muted">{t("riCompareWhyNoRooms")}</td>
              </tr>
            )}
            {explain.rows.map((row) => (
              <tr key={row.roomId} className="border-b border-line-alt/60 last:border-0">
                <td className="py-2 pr-3 font-medium text-secondary">
                  {row.roomTitle}
                  {row.otaRoomName && <span className="block text-[11.5px] font-normal text-muted">→ {row.otaRoomName}</span>}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(row.directTotalMinor)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(row.otaTotalMinor)}</td>
                <td className={`py-2 ${row.savingPct !== undefined ? "font-semibold text-emerald-700" : "text-muted"}`}>
                  {reason(row)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11.5px] text-muted">{t("riCompareWhyFootnote", { n: String(explain.nights) })}</p>
    </div>
  );
}

function DirectCompare({
  compare,
  ourRooms,
  otaRooms,
  suggested,
  imported,
  explain,
  checkin,
  checkError,
  busy,
}: {
  compare: { enabled: boolean; roomMap: Record<string, string>; bookingHotelId: string; minSavingPct: number; maxAgeHours: number };
  ourRooms: { id: string; title: string }[];
  otaRooms: { roomRef: string; name: string; maxPersons: number | null }[];
  suggested: Record<string, string>;
  explain?: CompareExplain;
  checkin?: string;
  checkError?: boolean;
  imported?: {
    ok: boolean;
    roomMap: Record<string, string>;
    channelTitle?: string;
    hotelId?: string;
    channels: { title?: string; hotelId?: string; isActive?: boolean; overlap: number }[];
    pickedBy?: string;
    conflicts: { roomId: string; codes: string[] }[];
    dropped: { roomId: string; code: string }[];
    error?: string;
  };
  busy: boolean;
}) {
  const t = useAdminT();
  const mappedCount = ourRooms.filter((r) => compare.roomMap[r.id]).length;
  const roomTitle = (id: string) => ourRooms.find((r) => r.id === id)?.title ?? id;
  const importErrorKey = ({
    not_connected: "riCompareImportNotConnected",
    no_channel: "riCompareImportNoChannel",
    not_mapped: "riCompareImportNotMapped",
    no_match: "riCompareImportNoMatch",
    rates_unknown: "riCompareImportRatesUnknown",
    ambiguous: "riCompareImportAmbiguous",
    hotel_id_not_found: "riCompareImportHotelIdNotFound",
  } as const)[imported?.error ?? ""];
  // Anything else (Channex down, timeout, rejected key) is shown verbatim rather
  // than swallowed — a button that silently does nothing is worse than an error.
  const importErrorRaw = imported && !imported.ok && !importErrorKey ? imported.error : undefined;

  // NOTE: no hidden `intent` field in this form. A hidden input appears BEFORE
  // the buttons in the submitted data, so form.get("intent") returns it and the
  // Import button silently saves instead of importing. Each button carries its
  // own intent.
  return (
    <Form method="post" className="mt-8 flex flex-col gap-5">
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="font-serif text-[19px] font-semibold">{t("riCompareTitle")}</h2>
        <p className="mt-1 text-[13px] text-muted">{t("riCompareSub")}</p>

        {otaRooms.length === 0 ? (
          <div className="mt-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            {t("riCompareNoCapture")}
          </div>
        ) : (
          <>
            <label className="mt-5 flex items-center gap-3">
              <input type="checkbox" name="compareEnabled" defaultChecked={compare.enabled} className="h-4 w-4" />
              <span>
                <span className="text-[14px] font-semibold">{t("riCompareEnabled")}</span>
                <span className="block text-[12.5px] text-muted">{t("riCompareEnabledSub")}</span>
              </span>
            </label>

            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-[13px] font-medium text-secondary">
                {t("riCompareMinSaving")}
                <input type="number" name="minSavingPct" min={1} max={50} defaultValue={compare.minSavingPct} className={`${FIELD} mt-1 block w-full`} />
                <span className="mt-1 block text-[12px] text-muted">{t("riCompareMinSavingSub")}</span>
              </label>
              <label className="text-[13px] font-medium text-secondary">
                {t("riCompareMaxAge")}
                <input type="number" name="maxAgeHours" min={1} max={720} defaultValue={compare.maxAgeHours} className={`${FIELD} mt-1 block w-full`} />
                <span className="mt-1 block text-[12px] text-muted">{t("riCompareMaxAgeSub")}</span>
              </label>
            </div>

            <div className="mt-6">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-secondary">{t("riCompareMapTitle")}</div>
                  <p className="mt-0.5 text-[12.5px] text-muted">{t("riCompareMapSub")}</p>
                </div>
                {/* Reads the property's Booking.com channel mapping from Channex.
                    formNoValidate + its own intent so it can't be mistaken for a
                    save, and nothing is stored until the owner saves below. */}
                <button
                  type="submit"
                  name="intent"
                  value="compareImport"
                  formNoValidate
                  disabled={busy}
                  className="rounded-[10px] border border-line-alt bg-surface px-4 py-2 text-[12.5px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                >
                  {t("riCompareImport")}
                </button>
              </div>

              {/* Which Booking.com connection to read. Spilman has two, so the
                  choice is real: an unpinned import infers it from the room codes
                  we've scraped, and this field overrides that. */}
              <label className="mt-3 block text-[13px] font-medium text-secondary">
                {t("riCompareHotelId")}
                <input
                  type="text"
                  name="bookingHotelId"
                  inputMode="numeric"
                  defaultValue={compare.bookingHotelId}
                  placeholder={t("riCompareHotelIdPlaceholder")}
                  className={`${FIELD} mt-1 block w-full max-w-[240px]`}
                />
                <span className="mt-1 block text-[12px] font-normal text-muted">{t("riCompareHotelIdSub")}</span>
              </label>

              {imported && imported.channels.length > 1 && (
                <div className="mt-3 rounded-[10px] border border-line-alt bg-chip/40 px-4 py-3 text-[12.5px] text-secondary">
                  <div className="font-semibold">{t("riCompareChannelsFound", { n: String(imported.channels.length) })}</div>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {imported.channels.map((c, i) => (
                      <li key={`${c.hotelId ?? "?"}-${i}`}>
                        {c.title || t("riCompareImportChannelFallback")}
                        {c.hotelId ? ` · ${t("riCompareChannelHotelId", { id: c.hotelId })}` : ""}
                        {` · ${t("riCompareChannelOverlap", { n: String(c.overlap) })}`}
                        {imported.hotelId && c.hotelId === imported.hotelId ? ` — ${t("riCompareChannelUsed")}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {imported?.ok && (
                <div className="mt-3 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[12.5px] text-emerald-900">
                  <div className="font-semibold">
                    {t("riCompareImportOk", {
                      n: String(Object.keys(imported.roomMap).length),
                      channel: imported.channelTitle || t("riCompareImportChannelFallback"),
                    })}
                    {imported.hotelId ? ` (${t("riCompareChannelHotelId", { id: imported.hotelId })})` : ""}
                  </div>
                  {imported.pickedBy === "code_overlap" && (
                    <div className="mt-0.5">{t("riCompareImportPickedByCodes")}</div>
                  )}
                  <div className="mt-0.5">{t("riCompareImportReview")}</div>
                </div>
              )}
              {imported && !imported.ok && importErrorKey && (
                <div className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
                  {t(importErrorKey)}
                </div>
              )}
              {importErrorRaw && (
                <div className="mt-3 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-800">
                  {t("riCompareImportFailed")} {importErrorRaw}
                </div>
              )}
              {imported && imported.conflicts.length > 0 && (
                <div className="mt-2 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
                  {t("riCompareImportConflicts", { rooms: imported.conflicts.map((c) => roomTitle(c.roomId)).join(", ") })}
                </div>
              )}
              {imported && imported.dropped.length > 0 && (
                <div className="mt-2 rounded-[10px] border border-line-alt bg-chip/40 px-4 py-3 text-[12.5px] text-secondary">
                  {t("riCompareImportDropped", { rooms: imported.dropped.map((d) => roomTitle(d.roomId)).join(", ") })}
                </div>
              )}

              <div className="mt-3 flex flex-col divide-y divide-line-alt rounded-[10px] border border-line-alt">
                {ourRooms.map((room) => {
                  const current = compare.roomMap[room.id] ?? "";
                  const suggestion = suggested[room.id] ?? "";
                  const fromChannex = imported?.roomMap[room.id] ?? "";
                  // Channex's own mapping outranks a name guess and the stored
                  // value, since it's what actually feeds Booking.
                  const value = fromChannex || current || suggestion;
                  return (
                    <div key={room.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-[160px] text-[13.5px] font-medium text-secondary">{room.title}</div>
                      <div className="flex items-center gap-2">
                        {fromChannex ? (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                            {t("riCompareFromChannex")}
                          </span>
                        ) : (
                          !current &&
                          suggestion && (
                            <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-secondary">
                              {t("riCompareSuggested")}
                            </span>
                          )
                        )}
                        <select
                          // Remount when the pre-filled value changes, so an
                          // import actually moves the visible selection.
                          key={value}
                          name={`map:${room.id}`}
                          defaultValue={value}
                          className={`${FIELD} min-w-[220px]`}
                        >
                          <option value="">{t("riCompareUnmapped")}</option>
                          {otaRooms.map((o) => (
                            <option key={o.roomRef} value={o.roomRef}>
                              {o.name}
                              {o.maxPersons ? ` · ${t("riRoomsSleeps", { n: String(o.maxPersons) })}` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[12px] text-muted">
                {t("riCompareMapped", { n: String(mappedCount), total: String(ourRooms.length) })}
              </p>
            </div>

            <div className="mt-5 rounded-[10px] border border-line-alt bg-chip/40 px-4 py-3 text-[12.5px] text-secondary">
              <span className="font-semibold">{t("riCompareHonestyTitle")}</span> {t("riCompareHonestyBody")}
            </div>

            {/* The badge is silent by design, which makes "nothing appeared"
                impossible to diagnose. This runs the real comparison for a date
                and reports the one reason per room. */}
            <div className="mt-6 rounded-[10px] border border-line-alt p-4">
              <div className="text-[13px] font-semibold text-secondary">{t("riCompareCheckTitle")}</div>
              <p className="mt-0.5 text-[12.5px] text-muted">{t("riCompareCheckSub")}</p>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="text-[11.5px] font-medium text-muted">
                  {t("riCompareCheckDate")}
                  <input type="date" name="checkDate" defaultValue={checkin ?? ""} className={`${FIELD} mt-0.5 block`} />
                </label>
                <label className="text-[11.5px] font-medium text-muted">
                  {t("riCompareCheckNights")}
                  <input type="number" name="checkNights" min={1} max={30} defaultValue={1} className={`${FIELD} mt-0.5 block w-[80px]`} />
                </label>
                <label className="text-[11.5px] font-medium text-muted">
                  {t("riCompareCheckAdults")}
                  <input type="number" name="checkAdults" min={1} max={10} defaultValue={2} className={`${FIELD} mt-0.5 block w-[80px]`} />
                </label>
                <button
                  type="submit"
                  name="intent"
                  value="compareCheck"
                  formNoValidate
                  disabled={busy}
                  className="rounded-[10px] border border-line-alt bg-surface px-4 py-2 text-[12.5px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                >
                  {t("riCompareCheckRun")}
                </button>
              </div>
              {checkError && <p className="mt-2 text-[12.5px] text-amber-800">{t("riCompareCheckBadDate")}</p>}
              {explain && <CheckResult explain={explain} />}
            </div>
          </>
        )}
      </section>

      {otaRooms.length > 0 && (
        <div>
          <button type="submit" name="intent" value="compare" disabled={busy} className="rounded-[10px] bg-accent px-6 py-2.5 text-[14px] font-semibold text-white disabled:opacity-60">
            {t("riSave")}
          </button>
        </div>
      )}
    </Form>
  );
}
