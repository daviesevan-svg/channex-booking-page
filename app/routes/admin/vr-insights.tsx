// VR insights — the single-unit (vacation-rental) counterpart to /admin/revenue.
// The hotel revenue tools assume a multi-room inventory and a Booking.com comp
// set; a short-term rental needs a different comp basis, so this page builds a
// comparable-listings set from Airbnb, matched on unit type + review quality.
// (Rental-tailored demand analytics land here in a later phase.)
import { useEffect, useState } from "react";
import { Form, Link, useNavigation, useRevalidator } from "react-router";

import type { Route } from "./+types/vr-insights";
import { FeatureUnavailable } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { useAdminDateLocale, useAdminT } from "~/lib/admin-i18n";
import { currentPropertyId } from "~/lib/properties.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { isScrapflyConfigured } from "~/lib/scrapfly.server";
import { fmtDate, todayISODate } from "~/lib/dates";
import { formatMoney } from "~/lib/money";
import { getBalance } from "~/lib/revman-tokens.server";
import {
  addVrComp,
  getVrCompSet,
  removeVrComp,
  setSelfListing,
  updateVrComp,
} from "~/lib/vr-compset.server";
import { discoverVrComps, type CandidateVrUnit } from "~/lib/vr-compset-discovery.server";
import {
  enqueueVrCaptureJob,
  estimateVrCost,
  getMarketPace,
  getMarketPickup,
  getVrAvail,
  getVrCaptureJob,
  getVrCaptureSettings,
  getVrPrices,
  lastVrCapturedAt,
  nudgeVrCaptureJob,
  setVrCaptureSettings,
} from "~/lib/vr-comp-capture.server";

const DAY = 86_400_000;
const isoAt = (base: string, add: number) => new Date(Date.parse(`${base}T00:00:00Z`) + add * DAY).toISOString().slice(0, 10);

/** Median of a numeric list (minor units), or null when empty. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { configured: false as const };
  const settings = await getSettings(pid);
  // This page is the inverse of the RMS gate: single-unit ONLY.
  if (settings.singleUnit !== true) return { configured: true as const, singleUnit: false as const };

  const [set, overrides, capSettings, balance, job, lastCap] = await Promise.all([
    getVrCompSet(pid),
    getOverrides(pid),
    getVrCaptureSettings(pid),
    getBalance(pid),
    getVrCaptureJob(pid),
    lastVrCapturedAt(pid),
  ]);
  const area = [settings.addressCity, settings.addressRegion, settings.addressCountry]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(", ");

  // Drive-by nudge for a running capture (backup to the self-fetch chain).
  if (job?.status === "running") nudgeVrCaptureJob(pid);

  const today = todayISODate();
  const to = isoAt(today, capSettings.horizonDays - 1);
  const [pace, pickup, availRows, priceRows] = await Promise.all([
    getMarketPace(pid, today, to, today),
    getMarketPickup(pid, today, to),
    getVrAvail(pid, today, to),
    getVrPrices(pid, today, to),
  ]);

  // Prices come from their own (coarser) feed, so a date may have availability
  // without a price sample — median over whatever comps were priced.
  const pricesForDate = new Map<string, number[]>();
  for (const r of priceRows) {
    if (r.priceMinor == null) continue;
    const arr = pricesForDate.get(r.date) ?? [];
    arr.push(r.priceMinor);
    pricesForDate.set(r.date, arr);
  }
  const priceByDate = new Map<string, number>();
  for (const [d, xs] of pricesForDate) {
    const m = median(xs);
    if (m != null) priceByDate.set(d, m);
  }
  // Typical minimum stay per date across comps — explains an "unavailable" that
  // is really a stay-length rule.
  const minNightsByDate = new Map<string, number>();
  for (const r of availRows) {
    if (r.minNights && r.minNights > (minNightsByDate.get(r.date) ?? 0)) minNightsByDate.set(r.date, r.minNights);
  }
  const pickupByDate = new Map(pickup.map((p) => [p.date, p]));
  const currency = priceRows.find((r) => r.currency)?.currency || settings.currency || "GBP";

  return {
    configured: true as const,
    singleUnit: true as const,
    set,
    area,
    ownName: overrides.hotelName || "",
    scrapflyOn: isScrapflyConfigured(),
    capSettings,
    balance,
    job,
    lastCap,
    rows: pace.map((p) => ({
      ...p,
      priceMinor: priceByDate.get(p.date) ?? null,
      maxMinNights: minNightsByDate.get(p.date) ?? null,
      bookedRecent: pickupByDate.get(p.date)?.bookedRecent ?? 0,
      openedRecent: pickupByDate.get(p.date)?.openedRecent ?? 0,
    })),
    currency,
    trackedCount: set.ranked.filter((u) => !u.isSelf && u.airbnbRef).length,
    cost: estimateVrCost(set.ranked.filter((u) => u.airbnbRef).length, capSettings),
  };
}

export function meta() {
  return [{ title: "Admin · VR insights" }];
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { error: "Select a property first." };
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "discover") {
      const area = String(form.get("area") || "").trim();
      const ownUrl = String(form.get("ownUrl") || "").trim();
      const ownName = (await getOverrides(pid)).hotelName || "";
      const result = await discoverVrComps(area, { selfRef: ownUrl || undefined, selfName: ownName || undefined });
      if (!result.ok) return { error: result.error ?? "Search failed." };
      // Score our own unit from the same search when we found it, so it ranks
      // on the same basis as its comps.
      if (result.self) {
        await setSelfListing(pid, {
          placeType: result.self.placeType,
          placeClass: result.self.placeClass,
          reviewScore: result.self.reviewScore,
          reviewCount: result.self.reviewCount,
          airbnbRef: result.self.airbnbRef,
        });
      }
      // Don't re-suggest units already in the set (match on ref or name).
      const set = await getVrCompSet(pid);
      const haveRef = new Set(set.ranked.map((u) => u.airbnbRef).filter(Boolean));
      const haveName = new Set(set.ranked.map((u) => u.name.toLowerCase()));
      const candidates = result.candidates.filter(
        (c) => !(c.airbnbRef && haveRef.has(c.airbnbRef)) && !haveName.has(c.name.toLowerCase()),
      );
      return { discover: { candidates, cost: result.cost, area, foundSelf: Boolean(result.self) } };
    }
    if (intent === "addBulk") {
      const picked = form.getAll("cand").map(String);
      let added = 0;
      for (const raw of picked) {
        try {
          const c = JSON.parse(raw) as CandidateVrUnit;
          if (c?.name) {
            await addVrComp(pid, {
              name: c.name,
              placeType: c.placeType,
              placeClass: c.placeClass,
              reviewScore: c.reviewScore,
              reviewCount: c.reviewCount,
              airbnbRef: c.airbnbRef,
            });
            added++;
          }
        } catch {
          /* skip malformed row */
        }
      }
      return { okKey: "vrAdded" as const, addedCount: added };
    }
    if (intent === "selfUpdate") {
      await updateVrComp(pid, "self", {
        name: String(form.get("name") || ""),
        placeType: form.get("placeType"),
        placeClass: form.get("placeClass"),
        reviewScore: form.get("reviewScore"),
        reviewCount: form.get("reviewCount"),
      });
      return { okKey: "vrSaved" as const };
    }
    if (intent === "remove") {
      await removeVrComp(pid, String(form.get("compId")));
      return { okKey: "vrSaved" as const };
    }
    if (intent === "captureNow") {
      if ((await getBalance(pid)) < 1) return { error: "Out of capture tokens." };
      const cap = await getVrCaptureSettings(pid);
      const today = todayISODate();
      const res = await enqueueVrCaptureJob(pid, today, isoAt(today, cap.horizonDays - 1), "manual");
      if (!res.ok) return { error: res.error ?? "Could not start capture." };
      return { okKey: "vrCaptureStarted" as const };
    }
    if (intent === "captureSettings") {
      await setVrCaptureSettings(pid, {
        enabled: form.get("enabled") === "on",
        horizonDays: Number(form.get("horizonDays")),
        priceEnabled: form.get("priceEnabled") === "on",
        priceCadenceDays: Number(form.get("priceCadenceDays")),
        priceHorizonDays: Number(form.get("priceHorizonDays")),
      });
      return { okKey: "vrSaved" as const };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
  return null;
}

const CLASS_LABEL: Record<string, "vrClassEntire" | "vrClassPrivate"> = {
  entire: "vrClassEntire",
  private: "vrClassPrivate",
};

export default function VrInsights({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const dl = useAdminDateLocale();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const busyIntent = busy ? String(nav.formData?.get("intent") ?? "") : "";
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  // While a capture runs, poll so the progress + pickup table fill in.
  const capturing = loaderData.configured && "job" in loaderData && loaderData.job?.status === "running";
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!capturing) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 4000);
    return () => clearInterval(id);
  }, [capturing, revalidator]);

  if (!loaderData.configured) {
    return (
      <div>
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("vrTitle")}</h1>
        <p className="text-[14px] text-muted">
          {t("anSelectPropertyPrefix")}{" "}
          <Link to="/admin/select-property" className="text-accent underline">{t("anSelectPropertyLink")}</Link>.
        </p>
      </div>
    );
  }
  if (!loaderData.singleUnit) return <FeatureUnavailable title={t("vrTitle")} body={t("vrSingleUnitOnly")} />;

  const { set, area, scrapflyOn, capSettings, balance, job, lastCap, rows, currency, trackedCount, cost } = loaderData;
  const money = (minor: number) => formatMoney(minor / 100, currency);
  const PACE_STYLE: Record<string, string> = {
    ahead: "bg-rose-100 text-rose-800",
    on_track: "bg-chip text-secondary",
    behind: "bg-sky-100 text-sky-800",
    unknown: "",
  };
  const PACE_LABEL: Record<string, "vrPaceAhead" | "vrPaceOnTrack" | "vrPaceBehind"> = {
    ahead: "vrPaceAhead",
    on_track: "vrPaceOnTrack",
    behind: "vrPaceBehind",
  };
  const discover = actionData && "discover" in actionData ? actionData.discover : undefined;
  const matchLabel = (m: number | null) =>
    m === null ? "" : m === 1 ? t("vrMatchSame") : m >= 0.5 ? t("vrMatchClass") : t("vrMatchDiff");
  const matchClass = (m: number | null) =>
    m === null ? "" : m === 1 ? "bg-emerald-100 text-emerald-800" : m >= 0.5 ? "bg-chip text-secondary" : "bg-amber-100 text-amber-800";

  return (
    <div className="max-w-[860px]">
      <h1 className="font-serif text-[26px] font-semibold">{t("vrTitle")}</h1>
      <p className="mb-6 mt-1 text-[13.5px] text-muted">{t("vrSubtitle")}</p>

      {actionData && "error" in actionData && actionData.error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700">{actionData.error}</p>
      )}
      {actionData && "okKey" in actionData && actionData.okKey === "vrAdded" && (
        <p className="mb-4 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-800">
          {t("vrAdded", { count: String("addedCount" in actionData ? actionData.addedCount : 0) })}
        </p>
      )}
      {actionData && "okKey" in actionData && (actionData.okKey === "vrSaved" || actionData.okKey === "vrCaptureStarted") && (
        <p className="mb-4 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-800">
          {t(actionData.okKey)}
        </p>
      )}

      {/* Standing headline */}
      <section className="mb-5 rounded-[14px] border border-line bg-surface p-5">
        <div className="font-serif text-[18px] font-semibold">{t("vrCompTitle")}</div>
        <p className="mb-3 mt-1 max-w-[620px] text-[13px] text-muted">{t("vrCompSub")}</p>
        {set.standing.position !== null ? (
          <p className="text-[13.5px]">
            {t("vrStanding", { pos: String(set.standing.position), n: String(set.standing.rated) })}
          </p>
        ) : (
          <p className="text-[13.5px] text-amber-700">{set.selfUntyped ? t("vrSelfUntyped") : t("vrSelfUnrated")}</p>
        )}
      </section>

      {/* Discover */}
      <section className="mb-5 rounded-[14px] border border-line bg-surface p-5">
        <div className="font-serif text-[16px] font-semibold">{t("vrDiscoverTitle")}</div>
        <p className="mb-3 mt-1 max-w-[620px] text-[13px] text-muted">{t("vrDiscoverSub")}</p>
        {!scrapflyOn ? (
          <p className="text-[13px] text-amber-700">{t("vrScrapflyOff")}</p>
        ) : (
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="discover" />
            <label className="text-[13px] font-semibold text-secondary">
              {t("vrArea")}
              <input
                name="area"
                defaultValue={area}
                className="mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-2.5 text-[14px]"
              />
            </label>
            <label className="text-[13px] font-semibold text-secondary">
              {t("vrOwnListing")}
              <input
                name="ownUrl"
                placeholder="https://www.airbnb.co.uk/rooms/…"
                className="mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-2.5 text-[14px]"
              />
              <span className="mt-1 block text-[12px] font-normal text-faint">{t("vrOwnListingHint")}</span>
            </label>
            <button
              type="submit"
              disabled={busy}
              className="self-start rounded-[10px] bg-accent px-4 py-2 text-[13.5px] font-semibold text-white disabled:opacity-60"
            >
              {busyIntent === "discover" ? t("vrFinding") : t("vrFind")}
            </button>
          </Form>
        )}

        {/* Review-then-confirm */}
        {discover && (
          <div className="mt-5 border-t border-line-alt pt-4">
            {discover.candidates.length === 0 ? (
              <p className="text-[13px] text-muted">{t("vrNoCandidates")}</p>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="addBulk" />
                <p className="mb-2 text-[13px] text-muted">
                  {t("vrReviewSub", { count: String(discover.candidates.length) })}
                  {discover.foundSelf ? ` ${t("vrFoundSelf")}` : ""}
                </p>
                <div className="max-h-[360px] overflow-y-auto rounded-[10px] border border-line-alt">
                  <table className="w-full text-[13px]">
                    <tbody>
                      {discover.candidates.map((c, i) => {
                        const key = c.airbnbRef || `${c.name}-${i}`;
                        const on = checked[key] ?? true;
                        return (
                          <tr key={key} className="border-t border-line-alt first:border-t-0">
                            <td className="px-3 py-2 align-top">
                              <input
                                type="checkbox"
                                name="cand"
                                value={JSON.stringify(c)}
                                checked={on}
                                onChange={(e) => setChecked((m) => ({ ...m, [key]: e.target.checked }))}
                              />
                            </td>
                            <td className="px-2 py-2">
                              <div className="font-semibold">{c.name}</div>
                              <div className="text-[12px] text-muted">
                                {c.placeType ?? "—"}
                                {c.placeClass ? ` · ${t(CLASS_LABEL[c.placeClass])}` : ""}
                              </div>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right text-[12.5px]">
                              {c.reviewScore ? `★ ${c.reviewScore} (${c.reviewCount ?? 0})` : t("vrUnrated")}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="mt-3 rounded-[10px] bg-accent px-4 py-2 text-[13.5px] font-semibold text-white disabled:opacity-60"
                >
                  {t("vrAddSelected")}
                </button>
              </Form>
            )}
          </div>
        )}
      </section>

      {/* The set */}
      <section className="rounded-[14px] border border-line bg-surface p-5">
        <div className="mb-3 font-serif text-[16px] font-semibold">{t("vrSetTitle")}</div>
        <div className="overflow-x-auto rounded-[10px] border border-line-alt">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-alt text-left text-[11.5px] uppercase tracking-[0.06em] text-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">{t("vrColRank")}</th>
                <th className="px-3 py-2 font-semibold">{t("vrColName")}</th>
                <th className="px-3 py-2 font-semibold">{t("vrColType")}</th>
                <th className="px-3 py-2 font-semibold">{t("vrColQuality")}</th>
                <th className="px-3 py-2 font-semibold">{t("vrColMatch")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {set.ranked.map((u) => (
                <tr key={u.id} className={`border-t border-line-alt ${u.isSelf ? "bg-chip/40" : ""}`}>
                  <td className="px-3 py-2 font-semibold">{u.rank ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="font-semibold">
                      {u.name}
                      {u.isSelf && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">{t("vrYou")}</span>}
                    </div>
                    <div className="text-[12px] text-muted">
                      {u.reviewScore ? `★ ${u.reviewScore} (${u.reviewCount ?? 0})` : t("vrUnrated")}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[12.5px]">
                    {u.placeType ?? "—"}
                    {u.placeClass ? <span className="ml-1 text-muted">· {t(CLASS_LABEL[u.placeClass])}</span> : ""}
                  </td>
                  <td className="px-3 py-2 font-semibold">{u.qualityIndex ?? "—"}</td>
                  <td className="px-3 py-2">
                    {u.typeMatch !== null && (
                      <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${matchClass(u.typeMatch)}`}>
                        {matchLabel(u.typeMatch)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!u.isSelf && (
                      <Form method="post" className="inline">
                        <input type="hidden" name="intent" value="remove" />
                        <input type="hidden" name="compId" value={u.id} />
                        <button type="submit" disabled={busy} className="text-[12px] text-muted hover:text-red-600">
                          {t("vrRemove")}
                        </button>
                      </Form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Edit your own unit */}
        {(() => {
          const self = set.ranked.find((u) => u.isSelf);
          if (!self) return null;
          return (
            <Form method="post" className="mt-4 flex flex-wrap items-end gap-3 border-t border-line-alt pt-4">
              <input type="hidden" name="intent" value="selfUpdate" />
              <div className="text-[13px] font-semibold text-secondary">{t("vrSelfEditTitle")}</div>
              <label className="text-[12px] text-secondary">
                {t("vrColName")}
                <input name="name" defaultValue={self.name} className="mt-1 block rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px]" />
              </label>
              <label className="text-[12px] text-secondary">
                {t("vrColType")}
                <input name="placeType" defaultValue={self.placeType ?? ""} placeholder="cottage" className="mt-1 block w-28 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px]" />
              </label>
              <label className="text-[12px] text-secondary">
                {t("vrColClass")}
                <select name="placeClass" defaultValue={self.placeClass ?? "entire"} className="mt-1 block rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px]">
                  <option value="entire">{t("vrClassEntire")}</option>
                  <option value="private">{t("vrClassPrivate")}</option>
                </select>
              </label>
              <label className="text-[12px] text-secondary">
                {t("vrColScore")}
                <input name="reviewScore" type="number" step="0.01" min="0" max="5" defaultValue={self.reviewScore ?? ""} className="mt-1 block w-20 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px]" />
              </label>
              <label className="text-[12px] text-secondary">
                {t("vrColReviews")}
                <input name="reviewCount" type="number" min="0" defaultValue={self.reviewCount ?? ""} className="mt-1 block w-24 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px]" />
              </label>
              <button type="submit" disabled={busy} className="rounded-[8px] border border-line-alt px-3 py-1.5 text-[12.5px] font-semibold text-secondary hover:bg-chip disabled:opacity-50">
                {t("vrSave")}
              </button>
            </Form>
          );
        })()}
      </section>

      {/* Market availability + pickup */}
      <section className="mt-5 rounded-[14px] border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-serif text-[16px] font-semibold">{t("vrMarketTitle")}</div>
            <p className="mt-1 max-w-[620px] text-[13px] text-muted">{t("vrMarketSub")}</p>
          </div>
          <div className="text-right text-[12.5px] text-muted">
            <div>{t("vrTokens", { n: String(balance) })}</div>
            {lastCap && <div className="text-faint">{t("vrLastCapture", { when: fmtDate(lastCap.slice(0, 10), "d MMM", dl) })}</div>}
          </div>
        </div>

        {!scrapflyOn ? (
          <p className="mt-3 text-[13px] text-amber-700">{t("vrScrapflyOff")}</p>
        ) : trackedCount === 0 ? (
          <p className="mt-3 text-[13px] text-muted">{t("vrNoTracked")}</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-end gap-4">
              <Form method="post">
                <input type="hidden" name="intent" value="captureNow" />
                <button
                  type="submit"
                  disabled={busy || balance < 1 || Boolean(job && job.status === "running")}
                  className="rounded-[10px] bg-accent px-4 py-2 text-[13.5px] font-semibold text-white disabled:opacity-60"
                >
                  {job?.status === "running" ? t("vrCapturing") : t("vrCaptureNow")}
                </button>
              </Form>
              <Form method="post" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="intent" value="captureSettings" />
                <label className="flex items-center gap-1.5 text-[12.5px] text-secondary">
                  <input type="checkbox" name="enabled" defaultChecked={capSettings.enabled} /> {t("vrAutoCapture")}
                </label>
                <label className="text-[12px] text-secondary">
                  {t("vrHorizon")}
                  <input name="horizonDays" type="number" min="1" max="365" defaultValue={capSettings.horizonDays} className="mt-1 block w-20 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px]" />
                </label>
                <label className="flex items-center gap-1.5 text-[12.5px] text-secondary">
                  <input type="checkbox" name="priceEnabled" defaultChecked={capSettings.priceEnabled} /> {t("vrPriceEnabled")}
                </label>
                <label className="text-[12px] text-secondary">
                  {t("vrPriceEvery")}
                  <input name="priceCadenceDays" type="number" min="1" max="90" defaultValue={capSettings.priceCadenceDays} className="mt-1 block w-16 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px]" />
                </label>
                <label className="text-[12px] text-secondary">
                  {t("vrPriceWithin")}
                  <input name="priceHorizonDays" type="number" min="1" max="365" defaultValue={capSettings.priceHorizonDays} className="mt-1 block w-20 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px]" />
                </label>
                <button type="submit" disabled={busy} className="rounded-[8px] border border-line-alt px-3 py-1.5 text-[12.5px] font-semibold text-secondary hover:bg-chip disabled:opacity-50">
                  {t("vrSave")}
                </button>
              </Form>
            </div>

            <p className="mt-2 text-[12px] text-faint">
              {t("vrCostEstimate", { avail: String(cost.avail), price: String(cost.price), total: String(cost.total) })}
            </p>

            {job && job.status !== "done" && (
              <div className="mt-3 text-[12.5px] text-muted">
                {job.status === "running" &&
                  t(job.phase === "price" ? "vrProgressPrice" : "vrProgressAvail", { done: String(job.done), total: String(job.total) })}
                {job.status === "paused" && job.reason === "no_tokens" && <span className="text-amber-700">{t("vrPausedTokens")}</span>}
                {job.status === "paused" && job.reason === "provider" && <span className="text-amber-700">{t("vrPausedProvider")}</span>}
              </div>
            )}

            {job?.calendarDegraded && (
              <p className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
                {t("vrCalendarDegraded")}
              </p>
            )}

            <p className="mt-4 rounded-[8px] bg-surface-alt px-3 py-2 text-[12px] text-faint">{t("vrPickupCaveat")}</p>

            <div className="mt-3 overflow-x-auto rounded-[10px] border border-line-alt">
              <table className="w-full text-[13px]">
                <thead className="bg-surface-alt text-left text-[11.5px] uppercase tracking-[0.06em] text-muted">
                  <tr>
                    <th className="px-3 py-2 font-semibold">{t("vrColDate")}</th>
                    <th className="px-3 py-2 font-semibold">{t("vrColMarket")}</th>
                    <th className="px-3 py-2 font-semibold">{t("vrColPace")}</th>
                    <th className="px-3 py-2 font-semibold">{t("vrColMedPrice")}</th>
                    <th className="px-3 py-2 font-semibold">{t("vrColPickup")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.filter((p) => p.tracked > 0).length === 0 ? (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-[13px] text-muted">{t("vrNoData")}</td></tr>
                  ) : (
                    rows
                      .filter((p) => p.tracked > 0)
                      .map((p) => (
                        <tr key={p.date} className="border-t border-line-alt">
                          <td className="whitespace-nowrap px-3 py-2">
                            <span className="font-semibold">{fmtDate(p.date, "EEE d MMM", dl)}</span>
                            {p.maxMinNights && p.maxMinNights > 1 && (
                              <span className="ml-1.5 text-[11px] text-faint" title={t("vrMinStayHint")}>
                                {t("vrMinStay", { n: String(p.maxMinNights) })}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className="inline-flex items-center gap-2">
                              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line-alt">
                                <span
                                  className={`block h-full ${(p.occupancy ?? 0) >= 0.8 ? "bg-rose-500" : (p.occupancy ?? 0) >= 0.5 ? "bg-amber-500" : "bg-emerald-500"}`}
                                  style={{ width: `${Math.round((p.occupancy ?? 0) * 100)}%` }}
                                />
                              </span>
                              <span className="text-[12px] text-muted">
                                {Math.round((p.occupancy ?? 0) * 100)}%
                              </span>
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {p.signal === "unknown" ? (
                              <span className="text-faint">—</span>
                            ) : (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${PACE_STYLE[p.signal]}`}
                                title={t("vrPaceTip", {
                                  expected: String(Math.round((p.expectedOccupancy ?? 0) * 100)),
                                  dba: String(p.dba),
                                })}
                              >
                                {t(PACE_LABEL[p.signal])}
                              </span>
                            )}
                            {p.velocity != null && p.velocity > 0 && (
                              <span className="ml-1.5 text-[11px] text-faint">{t("vrVelocity", { n: String(p.velocity) })}</span>
                            )}
                          </td>
                          <td className="px-3 py-2">{p.priceMinor != null ? money(p.priceMinor) : "—"}</td>
                          <td className="px-3 py-2">
                            {p.bookedRecent > 0 ? (
                              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11.5px] font-semibold text-rose-800">
                                {t("vrPickupCell", { n: String(p.bookedRecent) })}
                              </span>
                            ) : p.openedRecent > 0 ? (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11.5px] font-semibold text-emerald-800">
                                {t("vrOpenedCell", { n: String(p.openedRecent) })}
                              </span>
                            ) : (
                              <span className="text-faint">—</span>
                            )}
                          </td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
