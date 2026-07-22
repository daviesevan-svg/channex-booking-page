import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/google-hotels";
import { useAdminT } from "~/lib/admin-i18n";
import type { GoogleMatchStatus } from "~/lib/google-ari/status.server";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { isSuperadmin } from "~/lib/users.server";
import { getConfig } from "~/lib/config.server";
import { getGoogleAriSync, getSettings, saveGoogleAriSettings } from "~/lib/overrides.server";
import { checkGoogleReadiness } from "~/lib/google-readiness.server";
import { runAndRecord, ALL_SYNC_KINDS, type SyncKind } from "~/lib/google-ari/push.server";
import { readCachedMatchStatus } from "~/lib/google-ari/status.server";
import { refreshMergedGoogleFeed } from "~/lib/google-merged-feed.server";
import { refreshMergedVrFeed } from "~/lib/google-merged-vr-feed.server";

export async function loader({ request }: Route.LoaderArgs) {
  const email = await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const [canManage, superadmin] = await Promise.all([isOwnerOrSuper(request, propertyId), isSuperadmin(email)]);
  const matchConfigured = Boolean(
    getConfig().googleTravelPartnerAccountId &&
      getConfig().googleTravelPartnerSaEmail &&
      getConfig().googleTravelPartnerSaKey,
  );
  // The Travel Partner status is refreshed by the daily cron and read from KV
  // only here — never a live Google call on page load (that made this ~10s).
  const [settings, readiness, lastSync, cachedMatch] = await Promise.all([
    getSettings(propertyId),
    checkGoogleReadiness(propertyId),
    getGoogleAriSync(propertyId),
    matchConfigured ? readCachedMatchStatus(propertyId) : Promise.resolve(null),
  ]);
  const program = settings.googleProgram === "vacation_rentals" ? ("vacation_rentals" as const) : ("hotels" as const);
  const partnerConfigured =
    program === "vacation_rentals"
      ? Boolean(getConfig().googleVrPartnerKey)
      : Boolean(getConfig().googleAriPartnerKey);
  return {
    configured: true as const,
    canManage,
    propertyId,
    program,
    vrFeedUrl:
      program === "vacation_rentals"
        ? new URL("/feeds/google-vacation-rentals.xml", request.url).toString()
        : null,
    singleUnit: settings.singleUnit ?? false,
    partnerConfigured,
    push: settings.googleAriPush ?? false,
    windowDays: settings.googleAriWindowDays ?? 365,
    lastSync,
    readiness,
    matchConfigured,
    superadmin,
    matchStatus: cachedMatch?.status ?? null,
    matchCheckedAt: cachedMatch?.checkedAt ?? null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const email = await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // Rebuilding the merged Google feed is a global (all-property) action, so it's
  // superadmin-only and not tied to the current property.
  if (intent === "refreshFeed" || intent === "refreshVrFeed") {
    if (!(await isSuperadmin(email))) return { error: "Only a superadmin can refresh the Google feed." };
    const res = intent === "refreshVrFeed" ? await refreshMergedVrFeed(true) : await refreshMergedGoogleFeed(true);
    return res.ok
      ? { feedRefreshed: true as const }
      : { error: "Feed rebuild failed — the previous snapshot is unchanged (Channex feed unreachable?)." };
  }

  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  if (!(await isOwnerOrSuper(request, propertyId))) {
    return { error: "Only an owner or manager can manage Google Hotels." };
  }

  if (intent === "save") {
    const windowDays = Number(form.get("windowDays"));
    const program = form.get("program") === "vacation_rentals" ? "vacation_rentals" : "hotels";
    await saveGoogleAriSettings(propertyId, { push: form.get("push") === "on", windowDays, program });
    return { ok: true as const };
  }
  if (intent === "push") {
    // Manual pushes are internal plumbing — mirror the UI's superadmin gate.
    if (!(await isSuperadmin(email))) return { error: "Only a superadmin can push to Google manually." };
    const which = String(form.get("kinds") ?? "");
    const kinds: SyncKind[] =
      which === "all"
        ? ALL_SYNC_KINDS
        : (ALL_SYNC_KINDS as readonly string[]).includes(which)
          ? [which as SyncKind]
          : [];
    if (!kinds.length) return { error: "Nothing to push." };
    const results = await runAndRecord(propertyId, kinds);
    return { results };
  }
  return { error: "Unknown action." };
}

export function meta() {
  return [{ title: "Admin · Google Hotels" }];
}

export default function AdminGoogleHotels({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("ghTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("ghAddPropertyFirst")}</p>
      </div>
    );
  }
  if (!loaderData.canManage) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("ghTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("ghOwnerOnly")}</p>
      </div>
    );
  }

  const { partnerConfigured, push, windowDays, lastSync, readiness, matchStatus, matchConfigured, superadmin, program, singleUnit, vrFeedUrl } =
    loaderData;
  const isVr = program === "vacation_rentals";
  const programName = isVr ? t("ghTitleVr") : t("ghTitle");
  const input =
    "rounded-[10px] border border-line-alt bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent";
  const canPush = push && partnerConfigured && readiness.ready;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{programName}</h1>
        {actionData && "ok" in actionData && actionData.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">{t("saved")}</span>
        )}
      </div>

      <p className="max-w-2xl text-[14px] text-secondary">
        {t("ghIntro", { program: programName, feed: isVr ? t("ghVrListFeed") : t("ghHotelListFeed") })}
      </p>

      {actionData && "error" in actionData && actionData.error && (
        <p className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">
          {actionData.error}
        </p>
      )}

      {/* Prerequisites */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">{t("ghReadiness")}</h2>
        {!partnerConfigured && (
          <p className="mb-3 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-800">
            <strong>{isVr ? "GOOGLE_VR_PARTNER_KEY" : "GOOGLE_ARI_PARTNER_KEY"}</strong>{" "}
            {t("ghKeyNotSet", { product: isVr ? "Vacation Rentals" : "Hotel Center" })}
          </p>
        )}
        {readiness.ready ? (
          <p className="text-[14px] text-[#3f7a52]">{t("ghAllSet")}</p>
        ) : (
          <div>
            <p className="mb-2 text-[14px] text-secondary">{t("ghRequiredIntro")}</p>
            <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-red-700">
              {readiness.missingRequired.map((m) => (
                <li key={m.field}>{m.label}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Live match status from Google (Travel Partner API) — the Hotel Center
            matching flow, so it's shown for hotels only (VR ingests via the VR
            list feed, a different pipeline). */}
        {!isVr && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-divider pt-3.5 text-[13px]">
          <span className="text-secondary">{t("ghOnGoogle")}</span>
          {!matchConfigured ? (
            <span className="rounded-full bg-chip px-2.5 py-0.5 font-semibold text-muted">
              {t("ghNotCheckedSecrets")}
            </span>
          ) : matchStatus ? (
            <MatchStatusBadges status={matchStatus} />
          ) : (
            <span className="rounded-full bg-chip px-2.5 py-0.5 font-semibold text-muted">
              {t("ghNotCheckedYet")}
            </span>
          )}
        </div>
        )}
      </section>

      {/* Settings */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-4 font-serif text-[18px] font-semibold">{t("ghSettings")}</h2>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="save" />
          <div className="max-w-md">
            <span className="mb-1.5 block text-[13px] font-semibold text-secondary">{t("ghProgram")}</span>
            <select name="program" defaultValue={program} className={`${input} w-full`}>
              <option value="hotels">{t("ghTitle")}</option>
              <option value="vacation_rentals" disabled={!singleUnit}>
                {t("ghTitleVr")}{singleUnit ? "" : ` — ${t("ghSingleUnitOnly")}`}
              </option>
            </select>
            <span className="mt-1 block text-[12px] text-muted">
              {isVr ? t("ghProgramHintVr") : t("ghProgramHintHotels")}
            </span>
          </div>
          <label className="flex items-center gap-2.5 text-[14px] font-semibold text-ink">
            <input type="checkbox" name="push" defaultChecked={push} className="h-4 w-4 accent-[var(--accent)]" />
            {t("ghPushToggle", { program: programName })}
          </label>
          <label className="block max-w-xs">
            <span className="mb-1.5 block text-[13px] font-semibold text-secondary">{t("ghWindowDays")}</span>
            <input
              type="number"
              name="windowDays"
              min={1}
              max={500}
              defaultValue={windowDays}
              className={`${input} w-full`}
            />
            <span className="mt-1 block text-[12px] text-muted">{t("ghWindowDaysHint")}</span>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {t("ghSaveSettings")}
          </button>
        </Form>
      </section>

      {/* VR list feed — Google ingests a property's content from this feed before
          ARI prices attach. Internal plumbing (the feed is handed to Google's
          TAM once, account-wide), so superadmin only. */}
      {isVr && vrFeedUrl && superadmin && (
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <h2 className="mb-2 font-serif text-[18px] font-semibold">{t("ghVrListFeed")}</h2>
          <p className="mb-3 max-w-2xl text-[13px] text-muted">
            {t("ghVrFeedP1")} <strong>{t("ghVrFeedZip")}</strong> {t("ghVrFeedP2")}
          </p>
          <div className="flex flex-col gap-2">
            <div>
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-2">{t("ghVrFeedForGoogle")}</div>
              <code className="block break-all rounded-[10px] bg-chip px-3.5 py-2.5 text-[13px] text-secondary">
                {new URL("/feeds/google-vacation-rentals-all.zip", vrFeedUrl).toString()}
              </code>
            </div>
            <div>
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-2">{t("ghVrFeedPlainXml")}</div>
              <code className="block break-all rounded-[10px] bg-chip px-3.5 py-2.5 text-[12.5px] text-secondary">
                {new URL("/feeds/google-vacation-rentals-all.xml", vrFeedUrl).toString()}
                {"  ·  "}
                {vrFeedUrl}
              </code>
            </div>
          </div>
          <p className="mt-3 text-[12.5px] text-muted">
            {t("ghVrFeedContentP1")}{" "}
            <a href="/admin" className="font-semibold text-accent hover:underline">
              {t("ghPropertyDetailsLink")}
            </a>{" "}
            {t("ghVrFeedContentP2")}{" "}
            <a href="/admin/rooms" className="font-semibold text-accent hover:underline">
              {t("ghRoomsLink")}
            </a>
            .
          </p>
        </section>
      )}

      {/* Push — manual re-pushes are an internal/debugging tool (the cron and
          change-driven pushes keep Google in sync automatically), so superadmin
          only. Owners keep the settings + readiness above. */}
      {superadmin && (
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">{t("ghPushNow")}</h2>
        <p className="mb-4 max-w-2xl text-[13.5px] text-muted">
          {t("ghPushNowIntro")}
        </p>
        <div className="flex flex-wrap gap-2.5">
          {[
            { kinds: "all", label: t("ghPushEverything"), primary: true },
            { kinds: "property_data", label: t("ghPushPropertyData") },
            { kinds: "ari", label: t("ghPushAri") },
            { kinds: "taxes", label: t("ghPushTaxes") },
            { kinds: "promotions", label: t("ghPushPromotions") },
          ].map((b) => (
            <Form method="post" key={b.kinds}>
              <input type="hidden" name="intent" value="push" />
              <input type="hidden" name="kinds" value={b.kinds} />
              <button
                type="submit"
                disabled={busy || !canPush}
                title={canPush ? undefined : t("ghPushDisabledTitle")}
                className={
                  b.primary
                    ? "rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
                    : "rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                }
              >
                {b.label}
              </button>
            </Form>
          ))}
        </div>

        {actionData && "results" in actionData && actionData.results && (
          <div className="mt-4 space-y-2">
            {actionData.results.map((r, i) => (
              <div
                key={i}
                className={`rounded-[10px] border px-4 py-2.5 text-[13px] ${
                  r.ok ? "border-[#cfe3cf] bg-[#f2f8f1] text-[#3f7a52]" : "border-red-200 bg-red-50 text-red-700"
                }`}
              >
                <span className="font-semibold">{r.ok ? "✓" : "✗"} {r.kind}</span>
                <span className="ml-2 break-all font-mono text-[12px]">{r.detail}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {/* Last sync */}
      {lastSync && (
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <h2 className="mb-2 font-serif text-[18px] font-semibold">{t("ghLastPush")}</h2>
          <p className="mb-3 text-[13px] text-muted">{new Date(lastSync.at).toLocaleString()}</p>
          <div className="space-y-1.5">
            {lastSync.results.map((r, i) => (
              <div key={i} className="text-[13px]">
                <span className={r.ok ? "text-[#3f7a52]" : "text-red-700"}>{r.ok ? "✓" : "✗"} {r.kind}</span>
                <span className="ml-2 break-all font-mono text-[12px] text-muted">{r.detail}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Merged Google feed — global, superadmin only. Google pulls a once-a-day
          snapshot; this forces an immediate rebuild (e.g. after a property goes
          public) instead of waiting for the daily cron. */}
      {superadmin && (
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <h2 className="mb-2 font-serif text-[18px] font-semibold">{t("ghMergedFeed")}</h2>
          <p className="mb-4 max-w-2xl text-[13px] text-muted">
            {t("ghMergedFeedIntro")}
          </p>
          <ul className="mb-4 space-y-1 text-[12px] text-muted-2">
            <li>{t("ghFeedHotelsLabel")} <code className="rounded bg-chip px-1.5 py-0.5">/feeds/google-hotels-all.xml</code></li>
            <li>{t("ghFeedVrLabel")} <code className="rounded bg-chip px-1.5 py-0.5">/feeds/google-vacation-rentals-all.xml</code></li>
          </ul>
          {actionData && "feedRefreshed" in actionData && actionData.feedRefreshed && (
            <p className="mb-3 rounded-[10px] border border-[#cfe3cf] bg-[#f2f8f1] px-4 py-2.5 text-[13px] text-[#3f7a52]">
              {t("ghFeedRebuilt")}
            </p>
          )}
          <div className="flex flex-wrap gap-2.5">
            <Form method="post">
              <input type="hidden" name="intent" value="refreshFeed" />
              <button
                type="submit"
                disabled={busy}
                className="rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
              >
                {busy ? t("ghRebuilding") : t("ghRefreshHotelsFeed")}
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="refreshVrFeed" />
              <button
                type="submit"
                disabled={busy}
                className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {busy ? t("ghRebuilding") : t("ghRefreshVrFeed")}
              </button>
            </Form>
          </div>
        </section>
      )}
    </div>
  );
}

/** The "On Google" badges, rendered once the Travel Partner status resolves. */
function MatchStatusBadges({ status }: { status: GoogleMatchStatus }) {
  const t = useAdminT();
  return (
    <>
      <span
        className={`rounded-full px-2.5 py-0.5 font-semibold ${
          status.state === "matched"
            ? "bg-[#e8f0e6] text-[#3f7a52]"
            : status.state === "not_found"
              ? "bg-chip text-muted"
              : "bg-amber-50 text-amber-800"
        }`}
      >
        {status.state === "matched"
          ? t("ghMatchMatched")
          : status.state === "not_found"
            ? t("ghMatchNotFound")
            : status.state === "not_matched"
              ? t("ghMatchNotMatched")
              : status.state === "overlap"
                ? t("ghMatchOverlap")
                : t("ghMatchUnclear", { status: status.matchStatus ?? "" })}
      </span>
      {status.liveOnGoogle && (
        <span className="rounded-full bg-[#e8f0e6] px-2.5 py-0.5 font-semibold text-[#3f7a52]">{t("ghLiveOnGoogle")}</span>
      )}
      {status.state !== "matched" && status.reasons.length > 0 && (
        <span className="text-muted-2">· {status.reasons.join("; ")}</span>
      )}
    </>
  );
}
