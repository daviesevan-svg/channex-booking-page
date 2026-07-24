// VR insights — the single-unit (vacation-rental) counterpart to /admin/revenue.
// The hotel revenue tools assume a multi-room inventory and a Booking.com comp
// set; a short-term rental needs a different comp basis, so this page builds a
// comparable-listings set from Airbnb, matched on unit type + review quality.
// (Rental-tailored demand analytics land here in a later phase.)
import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/vr-insights";
import { FeatureUnavailable } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { useAdminT } from "~/lib/admin-i18n";
import { currentPropertyId } from "~/lib/properties.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { isScrapflyConfigured } from "~/lib/scrapfly.server";
import {
  addVrComp,
  getVrCompSet,
  removeVrComp,
  setSelfListing,
  updateVrComp,
} from "~/lib/vr-compset.server";
import { discoverVrComps, type CandidateVrUnit } from "~/lib/vr-compset-discovery.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const pid = await currentPropertyId(request);
  if (!pid) return { configured: false as const };
  const settings = await getSettings(pid);
  // This page is the inverse of the RMS gate: single-unit ONLY.
  if (settings.singleUnit !== true) return { configured: true as const, singleUnit: false as const };

  const [set, overrides] = await Promise.all([getVrCompSet(pid), getOverrides(pid)]);
  const area = [settings.addressCity, settings.addressRegion, settings.addressCountry]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return {
    configured: true as const,
    singleUnit: true as const,
    set,
    area,
    ownName: overrides.hotelName || "",
    scrapflyOn: isScrapflyConfigured(),
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
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const busyIntent = busy ? String(nav.formData?.get("intent") ?? "") : "";
  const [checked, setChecked] = useState<Record<string, boolean>>({});

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

  const { set, area, ownName, scrapflyOn } = loaderData;
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
    </div>
  );
}
