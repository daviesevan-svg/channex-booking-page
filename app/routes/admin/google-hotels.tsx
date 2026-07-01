import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/google-hotels";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { getSettings, saveGoogleAriSettings } from "~/lib/overrides.server";
import { checkGoogleReadiness } from "~/lib/google-readiness.server";
import { runAndRecord, ALL_SYNC_KINDS, type SyncKind } from "~/lib/google-ari/push.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const canManage = await isOwnerOrSuper(request, propertyId);
  const [settings, readiness] = await Promise.all([getSettings(propertyId), checkGoogleReadiness(propertyId)]);
  return {
    configured: true as const,
    canManage,
    propertyId,
    partnerConfigured: Boolean(getConfig().googleAriPartnerKey),
    push: settings.googleAriPush ?? false,
    windowDays: settings.googleAriWindowDays ?? 365,
    lastSync: settings.googleAriLastSync,
    readiness,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  if (!(await isOwnerOrSuper(request, propertyId))) {
    return { error: "Only an owner or manager can manage Google Hotels." };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "save") {
    const windowDays = Number(form.get("windowDays"));
    await saveGoogleAriSettings(propertyId, { push: form.get("push") === "on", windowDays });
    return { ok: true as const };
  }
  if (intent === "push") {
    const which = String(form.get("kinds") ?? "");
    const one = ["property_data", "ari", "taxes", "promotions"] as const;
    const kinds: SyncKind[] =
      which === "all" ? ALL_SYNC_KINDS : (one as readonly string[]).includes(which) ? [which as SyncKind] : [];
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

  const { partnerConfigured, push, windowDays, lastSync, readiness } = loaderData;
  const input =
    "rounded-[10px] border border-line-alt bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent";
  const canPush = push && partnerConfigured && readiness.ready;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Google Hotels</h1>
        {actionData && "ok" in actionData && actionData.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">✓ Saved</span>
        )}
      </div>

      <p className="max-w-2xl text-[14px] text-secondary">
        Push this property's rooms, rates, discounts and availability (ARI) directly to Google Hotels.
        Prices and discounts are computed by Roompanda, so Google always shows exactly what your site
        does. Google matches the property by its ID (same as the Hotel List Feed).
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
            <strong>GOOGLE_ARI_PARTNER_KEY</strong> is not set. Add your Hotel Center partner key as a
            Cloudflare secret before pushing.
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
      </section>

      {/* Settings */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-4 font-serif text-[18px] font-semibold">Settings</h2>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="save" />
          <label className="flex items-center gap-2.5 text-[14px] font-semibold text-ink">
            <input type="checkbox" name="push" defaultChecked={push} className="h-4 w-4 accent-[var(--accent)]" />
            Push this property to Google Hotels
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
    </div>
  );
}
