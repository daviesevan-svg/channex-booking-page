import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/google-hotels";
import type { GoogleMatchStatus } from "~/lib/google-ari/status.server";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { isSuperadmin } from "~/lib/users.server";
import { getConfig } from "~/lib/config.server";
import { getGoogleAriSync, getSettings, patchSettings, saveGoogleAriSettings } from "~/lib/overrides.server";
import { VR_AMENITIES, VR_AMENITY_ENUMS, VR_AMENITY_KEYS } from "~/lib/content";
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
    vrAmenities: settings.vrAmenities ?? [],
    vrAmenityOptions: settings.vrAmenityOptions ?? {},
    vrBedrooms: settings.vrBedrooms,
    vrBathrooms: settings.vrBathrooms,
    vrBeds: settings.vrBeds,
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
  if (intent === "saveAmenities") {
    // Only known amenity keys / enum values are stored (the form can't smuggle
    // an attribute Google would reject).
    const vrAmenities = form.getAll("amenity").map(String).filter((k) => VR_AMENITY_KEYS.has(k));
    const vrAmenityOptions: Record<string, string> = {};
    for (const def of VR_AMENITY_ENUMS) {
      const v = String(form.get(`enum_${def.key}`) ?? "");
      if (def.options.includes(v)) vrAmenityOptions[def.key] = v;
    }
    // Unit size: a valid non-negative number is saved; blank is left unchanged
    // (patchSettings skips undefined — these are required, rarely cleared).
    const count = (name: string): number | undefined => {
      const raw = String(form.get(name) ?? "").trim();
      if (raw === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    await patchSettings(propertyId, {
      vrAmenities,
      vrAmenityOptions,
      vrBedrooms: count("vrBedrooms"),
      vrBathrooms: count("vrBathrooms"),
      vrBeds: count("vrBeds"),
    });
    return { ok: true as const };
  }
  if (intent === "push") {
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
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Google Hotels</h1>
        <p className="text-[15px] text-secondary">Add a property first to push to Google.</p>
      </div>
    );
  }
  if (!loaderData.canManage) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Google Hotels</h1>
        <p className="text-[15px] text-secondary">Only an owner or manager can manage this for the property.</p>
      </div>
    );
  }

  const { partnerConfigured, push, windowDays, lastSync, readiness, matchStatus, matchConfigured, superadmin, program, singleUnit, vrFeedUrl, vrAmenities, vrAmenityOptions, vrBedrooms, vrBathrooms, vrBeds } =
    loaderData;
  const isVr = program === "vacation_rentals";
  const countsMissing = vrBedrooms == null || vrBathrooms == null || vrBeds == null;
  const input =
    "rounded-[10px] border border-line-alt bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent";
  const canPush = push && partnerConfigured && readiness.ready;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{isVr ? "Google Vacation Rentals" : "Google Hotels"}</h1>
        {actionData && "ok" in actionData && actionData.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">✓ Saved</span>
        )}
      </div>

      <p className="max-w-2xl text-[14px] text-secondary">
        Push this property's rooms, rates, discounts and availability (ARI) directly to{" "}
        {isVr ? "Google Vacation Rentals" : "Google Hotels"}. Prices and discounts are computed by Roompanda,
        so Google always shows exactly what your site does. Google matches the property by its ID (same as the{" "}
        {isVr ? "Vacation Rentals list feed" : "Hotel List Feed"}).
      </p>

      {actionData && "error" in actionData && actionData.error && (
        <p className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">
          {actionData.error}
        </p>
      )}

      {/* Prerequisites */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">Readiness</h2>
        {!partnerConfigured && (
          <p className="mb-3 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-800">
            <strong>{isVr ? "GOOGLE_VR_PARTNER_KEY" : "GOOGLE_ARI_PARTNER_KEY"}</strong> is not set. Add your{" "}
            {isVr ? "Vacation Rentals" : "Hotel Center"} partner key as a Cloudflare secret before pushing.
          </p>
        )}
        {readiness.ready ? (
          <p className="text-[14px] text-[#3f7a52]">✓ All required property details are set.</p>
        ) : (
          <div>
            <p className="mb-2 text-[14px] text-secondary">These are required before Google will accept the property:</p>
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
          <span className="text-secondary">On Google:</span>
          {!matchConfigured ? (
            <span className="rounded-full bg-chip px-2.5 py-0.5 font-semibold text-muted">
              Not checked — add Travel Partner API secrets to enable
            </span>
          ) : matchStatus ? (
            <MatchStatusBadges status={matchStatus} />
          ) : (
            <span className="rounded-full bg-chip px-2.5 py-0.5 font-semibold text-muted">
              Not checked yet — refreshed automatically once a day
            </span>
          )}
        </div>
        )}
      </section>

      {/* Settings */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-4 font-serif text-[18px] font-semibold">Settings</h2>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="save" />
          <div className="max-w-md">
            <span className="mb-1.5 block text-[13px] font-semibold text-secondary">Google program</span>
            <select name="program" defaultValue={program} className={`${input} w-full`}>
              <option value="hotels">Google Hotels</option>
              <option value="vacation_rentals" disabled={!singleUnit}>
                Google Vacation Rentals{singleUnit ? "" : " — single-unit properties only"}
              </option>
            </select>
            <span className="mt-1 block text-[12px] text-muted">
              {isVr
                ? "Pushes to your Vacation Rentals account as a single-unit listing with binary availability."
                : "Pushes to your Hotel Center account. Vacation Rentals is available for single-unit properties."}
            </span>
          </div>
          <label className="flex items-center gap-2.5 text-[14px] font-semibold text-ink">
            <input type="checkbox" name="push" defaultChecked={push} className="h-4 w-4 accent-[var(--accent)]" />
            Push this property to {isVr ? "Google Vacation Rentals" : "Google Hotels"}
          </label>
          <label className="block max-w-xs">
            <span className="mb-1.5 block text-[13px] font-semibold text-secondary">Days ahead to push</span>
            <input
              type="number"
              name="windowDays"
              min={1}
              max={500}
              defaultValue={windowDays}
              className={`${input} w-full`}
            />
            <span className="mt-1 block text-[12px] text-muted">Availability & rates are pushed for today + this many days (max 500).</span>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            Save settings
          </button>
        </Form>
      </section>

      {/* VR list feed — Google ingests a property's content from this feed before
          ARI prices attach. Shown for vacation-rental properties. */}
      {isVr && vrFeedUrl && (
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <h2 className="mb-2 font-serif text-[18px] font-semibold">Vacation Rentals list feed</h2>
          <p className="mb-3 max-w-2xl text-[13px] text-muted">
            Give this URL to your Google Vacation Rentals Technical Account Manager. Google pulls it on
            a schedule to ingest your property's content (name, address, location, capacity). A property
            must be ingested here before the prices you push above will show.
          </p>
          <code className="block break-all rounded-[10px] bg-chip px-3.5 py-2.5 text-[13px] text-secondary">
            {vrFeedUrl}
          </code>
        </section>
      )}

      {/* Amenities — Google's controlled vocabulary. Google builds the listing
          from the feed, so these enrich it. VR-only (fed into the VR feed). */}
      {isVr && (
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <h2 className="mb-1 font-serif text-[18px] font-semibold">Amenities</h2>
          <p className="mb-4 max-w-2xl text-[13px] text-muted">
            Tick what this property offers — Google uses these to build and filter your Vacation
            Rentals listing. (Free-text room facilities aren't sent to Google; only these.)
          </p>
          <Form method="post" className="space-y-5">
            <input type="hidden" name="intent" value="saveAmenities" />
            {/* Unit size — required by Google before a VR listing can go live. */}
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-secondary">Property size</span>
                {countsMissing ? (
                  <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[12px] font-semibold text-amber-800">
                    Required — Google won't publish the listing without these
                  </span>
                ) : (
                  <span className="rounded-full bg-[#e8f0e6] px-2.5 py-0.5 text-[12px] font-semibold text-[#3f7a52]">
                    ✓ Complete
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-4">
                {[
                  { name: "vrBedrooms", label: "Bedrooms", value: vrBedrooms, step: "1", hint: "0 for a studio" },
                  { name: "vrBathrooms", label: "Bathrooms", value: vrBathrooms, step: "0.5", hint: "e.g. 1.5" },
                  { name: "vrBeds", label: "Beds", value: vrBeds, step: "1", hint: "" },
                ].map((f) => (
                  <label key={f.name} className="block">
                    <span className="mb-1.5 block text-[13px] font-semibold text-secondary">{f.label}</span>
                    <input
                      type="number"
                      name={f.name}
                      min={0}
                      step={f.step}
                      defaultValue={f.value ?? ""}
                      className={`${input} w-28`}
                    />
                    {f.hint && <span className="mt-1 block text-[12px] text-muted">{f.hint}</span>}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-divider pt-4 sm:grid-cols-3">
              {VR_AMENITIES.map((a) => (
                <label key={a.key} className="flex items-center gap-2 text-[13.5px] text-secondary">
                  <input
                    type="checkbox"
                    name="amenity"
                    value={a.key}
                    defaultChecked={vrAmenities.includes(a.key)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  {a.label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 border-t border-divider pt-4">
              {VR_AMENITY_ENUMS.map((def) => (
                <label key={def.key} className="block">
                  <span className="mb-1.5 block text-[13px] font-semibold text-secondary">{def.label}</span>
                  <select name={`enum_${def.key}`} defaultValue={vrAmenityOptions[def.key] ?? ""} className={input}>
                    <option value="">Not specified</option>
                    {def.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button
              type="submit"
              disabled={busy}
              className="rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              Save amenities
            </button>
          </Form>
        </section>
      )}

      {/* Push */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">Push now</h2>
        <p className="mb-4 max-w-2xl text-[13.5px] text-muted">
          Send data to Google. All four core messages (property data, rates, availability, inventory)
          must be accepted before prices display; taxes compose the all-in price and promotions carry
          the discounts. "Push everything" sends them all in order.
        </p>
        <div className="flex flex-wrap gap-2.5">
          {[
            { kinds: "all", label: "Push everything", primary: true },
            { kinds: "property_data", label: "Property data" },
            { kinds: "ari", label: "Rates · availability · inventory" },
            { kinds: "taxes", label: "Taxes & fees" },
            { kinds: "promotions", label: "Promotions" },
          ].map((b) => (
            <Form method="post" key={b.kinds}>
              <input type="hidden" name="intent" value="push" />
              <input type="hidden" name="kinds" value={b.kinds} />
              <button
                type="submit"
                disabled={busy || !canPush}
                title={canPush ? undefined : "Enable the push, set the partner key and complete readiness first."}
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

      {/* Last sync */}
      {lastSync && (
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <h2 className="mb-2 font-serif text-[18px] font-semibold">Last push</h2>
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
          <h2 className="mb-2 font-serif text-[18px] font-semibold">Merged Google feed</h2>
          <p className="mb-4 max-w-2xl text-[13px] text-muted">
            Each merges Channex's partner feed with our own listings, rebuilt automatically once a day.
            Rebuild now to publish changes (like a property that just went public) without waiting for the
            daily refresh.
          </p>
          <ul className="mb-4 space-y-1 text-[12px] text-muted-2">
            <li>Hotels: <code className="rounded bg-chip px-1.5 py-0.5">/feeds/google-hotels-all.xml</code></li>
            <li>Vacation Rentals: <code className="rounded bg-chip px-1.5 py-0.5">/feeds/google-vacation-rentals-all.xml</code></li>
          </ul>
          {actionData && "feedRefreshed" in actionData && actionData.feedRefreshed && (
            <p className="mb-3 rounded-[10px] border border-[#cfe3cf] bg-[#f2f8f1] px-4 py-2.5 text-[13px] text-[#3f7a52]">
              ✓ Feed rebuilt — Google will see the latest listings on its next crawl.
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
                {busy ? "Rebuilding…" : "Refresh Hotels feed"}
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="refreshVrFeed" />
              <button
                type="submit"
                disabled={busy}
                className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {busy ? "Rebuilding…" : "Refresh Vacation Rentals feed"}
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
          ? "Matched — ready for rates"
          : status.state === "not_found"
            ? "Not uploaded to Google yet (feed not ingested)"
            : status.state === "not_matched"
              ? "Uploaded, but not matched to a business profile yet"
              : status.state === "overlap"
                ? "Uploaded — overlaps another listing (map overlap)"
                : `Status unclear (${status.matchStatus})`}
      </span>
      {status.liveOnGoogle && (
        <span className="rounded-full bg-[#e8f0e6] px-2.5 py-0.5 font-semibold text-[#3f7a52]">Live on Google</span>
      )}
      {status.state !== "matched" && status.reasons.length > 0 && (
        <span className="text-muted-2">· {status.reasons.join("; ")}</span>
      )}
    </>
  );
}
