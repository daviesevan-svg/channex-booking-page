// Rate mapping — a settings page for the rate board: which rate plan revenue
// management actually moves for each room type, how that room's other rate
// plans follow it, and (for reference) how the room types sit against each
// other. Split out of /admin/revenue, which had grown too long.
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/revenue.rate-mapping";
import { FeatureUnavailable } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { useAdminT, type AdminT } from "~/lib/admin-i18n";
import { todayISODate } from "~/lib/dates";
import { formatMoney } from "~/lib/money";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { getRevmanState } from "~/lib/revman.server";
import { getRevmanKpis } from "~/lib/revman-analytics.server";
import { cellKey, type DetectedLink } from "~/lib/revman-rate-link";
import { getLastPush, type LastPush } from "~/lib/channex/ari-push.server";
import {
  applyDetectedLinks,
  detectRateLinks,
  detectRoomRelations,
  getAriRatePairs,
  getRateLinkConfig,
  setRateLink,
  setRateMaster,
  setPushOnApply,
  setReferenceRoom,
  type AriRatePair,
  type RateLinkConfig,
  type RoomRelation,
} from "~/lib/revman-rate-link.server";

const WINDOW_DAYS = 60;
const windowTo = (today: string) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { configured: false as const };
  if ((await getSettings(pid)).singleUnit === true) return { configured: true as const, singleUnit: true as const };
  const state = await getRevmanState(pid);
  if (!state) return { configured: true as const, singleUnit: false as const, connected: false as const };

  const today = todayISODate();
  const to = windowTo(today);
  const [cfg, pairs, detections, rooms, kpis, lastPush] = await Promise.all([
    getRateLinkConfig(pid),
    getAriRatePairs(pid, today, to),
    detectRateLinks(pid, today, to),
    detectRoomRelations(pid, today, to),
    getRevmanKpis(pid, today, state.roomCount).catch(() => undefined),
    getLastPush(pid),
  ]);
  return {
    configured: true as const,
    singleUnit: false as const,
    connected: true as const,
    cfg,
    pairs,
    detections,
    rooms,
    currency: kpis?.currency,
    lastPush,
  };
}

export function meta() {
  return [{ title: "Admin · Rate mapping" }];
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { error: "Select a property first." };
  const form = await request.formData();
  const intent = String(form.get("intent"));
  try {
    if (intent === "rateMaster") {
      await setRateMaster(pid, String(form.get("roomId")), String(form.get("rateId") || ""));
      return { okKey: "revSaved" as const };
    }
    if (intent === "referenceRoom") {
      await setReferenceRoom(pid, String(form.get("roomId") || ""));
      return { okKey: "revSaved" as const };
    }
    if (intent === "rateLink") {
      const mode = String(form.get("mode")) === "fixed" ? "fixed" : "percent";
      const raw = String(form.get("value") || "").trim();
      const roomId = String(form.get("roomId"));
      const rateId = String(form.get("rateId"));
      if (raw === "") {
        await setRateLink(pid, roomId, rateId, null);
        return { okKey: "revSaved" as const };
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) return { errorKey: "revRateLinkErr" as const };
      await setRateLink(pid, roomId, rateId, { mode, value });
      return { okKey: "revSaved" as const };
    }
    if (intent === "pushOnApply") {
      await setPushOnApply(pid, form.get("on") === "on");
      return { okKey: "revSaved" as const };
    }
    if (intent === "rateDetect") {
      const today = todayISODate();
      const n = await applyDetectedLinks(pid, today, windowTo(today), { overwrite: true });
      return { okKey: "revRateDetected" as const, detectedCount: n };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
  return null;
}


/** Rate derivation: pick the rate plan revenue management moves for each room,
 *  and how that room's other rate plans follow it. Percentages suit discount
 *  tiers (they scale with the master); fixed amounts suit supplements like
 *  breakfast (a percentage would inflate them as the master rises). */
function RateMapping({
  cfg,
  pairs,
  detections,
  currency,
  busy,
  t,
}: {
  cfg: RateLinkConfig;
  pairs: AriRatePair[];
  detections: Record<string, DetectedLink>;
  currency?: string;
  busy: boolean;
  t: AdminT;
}) {
  const byRoom = new Map<string, AriRatePair[]>();
  for (const p of pairs) {
    const list = byRoom.get(p.roomId) ?? [];
    list.push(p);
    byRoom.set(p.roomId, list);
  }
  const field = "rounded-[7px] border border-line-alt bg-surface px-2 py-1 text-[12.5px]";

  return (
    <section className="mt-6 rounded-[14px] border border-line bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-serif text-[18px] font-semibold">{t("revRateMapTitle")}</div>
          <p className="mb-2 mt-1 max-w-[640px] text-[13px] text-muted">{t("revRateMapSub")}</p>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="rateDetect" />
          <button
            type="submit"
            disabled={busy}
            className="rounded-[9px] border border-line-alt px-3 py-1.5 text-[12.5px] font-semibold text-secondary hover:bg-chip disabled:opacity-50"
          >
            {t("revRateDetect")}
          </button>
        </Form>
      </div>

      {byRoom.size === 0 ? (
        <p className="mt-2 text-[13px] text-muted">{t("revRateMapNoPrices")}</p>
      ) : (
        <div className="mt-3 space-y-5">
          {[...byRoom.entries()].map(([roomId, rates]) => {
            const masterId = cfg.masterByRoom[roomId];
            const roomName = rates[0].roomName ?? roomId.slice(0, 8);
            return (
              <div key={roomId} className="rounded-[10px] border border-line-alt p-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="text-[13.5px] font-semibold text-secondary">{roomName}</div>
                  <Form method="post" className="flex items-end gap-2">
                    <input type="hidden" name="intent" value="rateMaster" />
                    <input type="hidden" name="roomId" value={roomId} />
                    <label className="text-[12px] text-muted">
                      {t("revRateMaster")}
                      <select name="rateId" defaultValue={masterId ?? ""} className={`${field} mt-0.5 block`}>
                        <option value="">{t("revRateNoMaster")}</option>
                        {rates.map((r) => (
                          <option key={r.rateId} value={r.rateId}>
                            {r.rateName ?? r.rateId.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-[8px] border border-line-alt px-2.5 py-1 text-[12px] font-semibold text-secondary hover:bg-chip disabled:opacity-50"
                    >
                      {t("revSave")}
                    </button>
                  </Form>
                </div>

                {!masterId ? (
                  <p className="mt-2 text-[12.5px] text-muted">{t("revRateNoMasterHint")}</p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {rates
                      .filter((r) => r.rateId !== masterId)
                      .map((r) => {
                        const key = cellKey(roomId, r.rateId);
                        const link = cfg.links[key];
                        const det = detections[key];
                        return (
                          <Form key={r.rateId} method="post" className="flex flex-wrap items-end gap-2 border-t border-line-alt pt-2">
                            <input type="hidden" name="intent" value="rateLink" />
                            <input type="hidden" name="roomId" value={roomId} />
                            <input type="hidden" name="rateId" value={r.rateId} />
                            <span className="min-w-[150px] flex-1 text-[12.5px] text-secondary">
                              {r.rateName ?? r.rateId.slice(0, 8)}
                            </span>
                            <label className="text-[11.5px] text-muted">
                              {t("revRateRelation")}
                              <select name="mode" defaultValue={link?.mode ?? det?.suggested ?? "percent"} className={`${field} mt-0.5 block`}>
                                <option value="percent">{t("revRateModePercent")}</option>
                                <option value="fixed">{t("revRateModeFixed", { cur: currency ?? "" })}</option>
                              </select>
                            </label>
                            <label className="text-[11.5px] text-muted">
                              {t("revRateValue")}
                              <input
                                name="value"
                                type="number"
                                step="0.01"
                                defaultValue={link?.value ?? (det?.suggested === "fixed" ? det?.fixed ?? "" : det?.percent ?? "")}
                                className={`${field} mt-0.5 block w-24`}
                              />
                            </label>
                            <button
                              type="submit"
                              disabled={busy}
                              className="rounded-[8px] border border-line-alt px-2.5 py-1 text-[12px] font-semibold text-secondary hover:bg-chip disabled:opacity-50"
                            >
                              {t("revSave")}
                            </button>
                            {det && det.samples > 0 && (
                              <span className="text-[11px] text-faint">
                                {t("revRateDetected", {
                                  pct: String(det.percent ?? 0),
                                  amt: String(det.fixed ?? 0),
                                  n: String(det.samples),
                                })}
                              </span>
                            )}
                          </Form>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Room types compared against one reference room. Descriptive only: each room
 *  type is still priced on its own demand, so nothing here derives a price —
 *  it's here so a hotelier can see whether their room ladder is a consistent
 *  percentage, a consistent amount, or has drifted. */
function RoomLadder({
  rooms,
  pairs,
  currency,
  busy,
  t,
}: {
  rooms: { referenceRoom?: string; referenceName?: string; relations: RoomRelation[] };
  pairs: AriRatePair[];
  currency?: string;
  busy: boolean;
  t: AdminT;
}) {
  const roomOptions = [...new Map(pairs.map((p) => [p.roomId, p.roomName ?? p.roomId.slice(0, 8)])).entries()];
  const money = (v: number) => formatMoney(v, currency ?? "GBP");

  return (
    <section className="mt-5 rounded-[14px] border border-line bg-surface p-6">
      <div className="font-serif text-[18px] font-semibold">{t("revRoomLadderTitle")}</div>
      <p className="mb-3 mt-1 max-w-[640px] text-[13px] text-muted">{t("revRoomLadderSub")}</p>

      {rooms.relations.length === 0 ? (
        <p className="text-[13px] text-muted">{t("revRoomLadderNone")}</p>
      ) : (
        <>
          <Form method="post" className="mb-3 flex items-end gap-2">
            <input type="hidden" name="intent" value="referenceRoom" />
            <label className="text-[12px] text-muted">
              {t("revRoomLadderRef")}
              <select
                name="roomId"
                defaultValue={rooms.referenceRoom ?? ""}
                className="mt-0.5 block rounded-[7px] border border-line-alt bg-surface px-2 py-1 text-[12.5px]"
              >
                {roomOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded-[8px] border border-line-alt px-2.5 py-1 text-[12px] font-semibold text-secondary hover:bg-chip disabled:opacity-50"
            >
              {t("revSave")}
            </button>
          </Form>

          <div className="overflow-x-auto rounded-[10px] border border-line-alt">
            <table className="w-full text-[13px]">
              <thead className="bg-surface-alt text-left text-[11.5px] uppercase tracking-[0.06em] text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">{t("revRoomLadderRoom")}</th>
                  <th className="px-3 py-2 font-semibold">{t("revRoomLadderVia")}</th>
                  <th className="px-3 py-2 font-semibold">{t("revRoomLadderPct")}</th>
                  <th className="px-3 py-2 font-semibold">{t("revRoomLadderAmt")}</th>
                  <th className="px-3 py-2 font-semibold">{t("revRoomLadderShape")}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-line-alt bg-chip/40">
                  <td className="px-3 py-2 font-semibold">{rooms.referenceName ?? rooms.referenceRoom?.slice(0, 8)}</td>
                  <td className="px-3 py-2 text-muted" colSpan={4}>
                    {t("revRoomLadderIsRef")}
                  </td>
                </tr>
                {rooms.relations.map((r) => (
                  <tr key={r.roomId} className="border-t border-line-alt">
                    <td className="px-3 py-2 font-semibold">{r.roomName ?? r.roomId.slice(0, 8)}</td>
                    <td className="px-3 py-2 text-[12px] text-muted">{r.viaRateName ?? r.viaRateId?.slice(0, 8) ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.detected.percent === null ? "—" : `${r.detected.percent > 0 ? "+" : ""}${r.detected.percent}%`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.detected.fixed === null ? "—" : `${r.detected.fixed > 0 ? "+" : ""}${money(r.detected.fixed)}`}
                    </td>
                    <td className="px-3 py-2">
                      {r.detected.suggested === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <span className="rounded-full bg-chip px-2 py-0.5 text-[11.5px] font-semibold text-secondary">
                          {t(r.detected.suggested === "fixed" ? "revRoomLadderSteadyAmt" : "revRoomLadderSteadyPct", {
                            n: String(r.detected.samples),
                          })}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** Sending applied prices on to Channex, which puts them in front of the OTAs.
 *  Off by default and stated plainly, because it writes to live inventory. */
function PushSettings({ on, lastPush, busy, t }: { on: boolean; lastPush?: LastPush; busy: boolean; t: AdminT }) {
  return (
    <section className="mt-5 rounded-[14px] border border-line bg-surface p-6">
      <div className="font-serif text-[18px] font-semibold">{t("revPushTitle")}</div>
      <p className="mb-3 mt-1 max-w-[640px] text-[13px] text-muted">{t("revPushSub")}</p>
      <Form method="post" className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="intent" value="pushOnApply" />
        <label className="flex items-center gap-2 text-[13px] text-secondary">
          <input type="checkbox" name="on" defaultChecked={on} /> {t("revPushEnable")}
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-[8px] border border-line-alt px-3 py-1.5 text-[12.5px] font-semibold text-secondary hover:bg-chip disabled:opacity-50"
        >
          {t("revSave")}
        </button>
      </Form>
      <p className="mt-2 rounded-[8px] bg-surface-alt px-3 py-2 text-[12px] text-faint">{t("revPushWarn")}</p>
      {lastPush && (
        <p className={`mt-2 text-[12.5px] ${lastPush.ok ? "text-muted" : "text-amber-700"}`}>
          {lastPush.error
            ? t("revPushLastError", { when: lastPush.at.slice(0, 16).replace("T", " "), error: lastPush.error })
            : lastPush.simulated
            ? t("revPushLastSimulated", { when: lastPush.at.slice(0, 16).replace("T", " "), n: String(lastPush.values) })
            : t("revPushLastOk", { when: lastPush.at.slice(0, 16).replace("T", " "), n: String(lastPush.values) })}
          {lastPush.skipped > 0 && ` ${t("revPushSkipped", { n: String(lastPush.skipped) })}`}
        </p>
      )}
    </section>
  );
}

export default function RateMappingPage({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  if (loaderData.configured && loaderData.singleUnit)
    return <FeatureUnavailable title={t("revSingleUnitTitle")} body={t("revSingleUnitBody")} />;
  if (!loaderData.configured || !loaderData.connected) {
    return (
      <div>
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("revRateMapTitle")}</h1>
        <p className="text-[14px] text-muted">
          {t("riConnectPrefix")}{" "}
          <Link to="/admin/revenue" className="text-accent underline">{t("navRevenue")}</Link>.
        </p>
      </div>
    );
  }

  const { cfg, pairs, detections, rooms, currency } = loaderData;
  return (
    <div className="max-w-[860px]">
      <div className="mb-1 text-[13px]">
        <Link to="/admin/revenue" className="text-accent hover:underline">← {t("navRevenue")}</Link>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700">{actionData.error}</p>
      )}
      {actionData && "errorKey" in actionData && actionData.errorKey && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700">{t(actionData.errorKey)}</p>
      )}
      {actionData && "okKey" in actionData && actionData.okKey && (
        <p className="mb-4 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-800">
          {actionData.okKey === "revRateDetected" && "detectedCount" in actionData
            ? t("revRateDetectedOk", { count: String(actionData.detectedCount) })
            : t(actionData.okKey)}
        </p>
      )}

      <RateMapping cfg={cfg} pairs={pairs} detections={detections} currency={currency} busy={busy} t={t} />
      <RoomLadder rooms={rooms} pairs={pairs} currency={currency} busy={busy} t={t} />
      <PushSettings on={cfg.pushOnApply} lastPush={loaderData.lastPush} busy={busy} t={t} />
    </div>
  );
}
