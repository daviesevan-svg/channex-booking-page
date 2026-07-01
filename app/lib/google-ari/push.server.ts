// Google Hotels ARI — transport + per-property push orchestration.
//
// Push model: we POST OTA/Transaction XML to Google's whitelisted upload
// endpoints (auth is IP-whitelist based — no key/secret in the request). Google
// answers 200 with an OTA body describing success or errors. Best-effort: these
// never throw into callers; every push returns a structured result and the
// outcome is recorded on the property so the admin can show it.
import { getConfig } from "../config.server";
import { getRooms, getRates } from "../catalog.server";
import type { SiteSettings } from "../content";
import { checkGoogleReadiness } from "../google-readiness.server";
import { getSettings, recordGoogleAriSync } from "../overrides.server";
import {
  buildAvailXml,
  buildInvCountXml,
  buildPromotionsXml,
  buildPropertyDataXml,
  buildRateAmountXml,
  buildTaxesXml,
  type AriEnvelope,
  type PropertyRate,
  type PropertyRoom,
} from "./xml";
import { getProperties } from "../properties.server";
import { waitUntil } from "cloudflare:workers";
import { ariWindow, collectAri, googleTaxLines } from "./rates.server";
import { googlePromotions } from "./promotions.server";

/** Google upload paths (joined onto `googleAriBaseUrl`). */
export const ARI_PATHS = {
  propertyData: "/travel/hotels/uploads/property_data",
  rate: "/travel/hotels/uploads/ota/hotel_rate_amount_notif",
  avail: "/travel/hotels/uploads/ota/hotel_avail_notif",
  inventory: "/travel/hotels/uploads/ota/hotel_inv_count_notif",
  taxes: "/travel/hotels/uploads/taxes",
  promotions: "/travel/hotels/uploads/promotions",
} as const;

export interface AriPushResult {
  /** Which message this is (e.g. "property_data"). */
  kind: string;
  ok: boolean;
  detail: string;
}

/** A short, safe message id: alphanumeric/underscore/dash only, per Google. */
function messageId(kind: string): string {
  const rand = crypto.randomUUID().replace(/-/g, "");
  return `${kind}_${rand}`;
}

function nowTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** POST an ARI XML document to a Google upload path and interpret the reply.
 *  Google returns HTTP 200 with an OTA body; we treat a non-2xx, a fetch error,
 *  or an error/failure marker in the body as a failure. */
export async function postToGoogleAri(kind: string, path: string, xml: string): Promise<AriPushResult> {
  const { googleAriBaseUrl, googleAriProxyKey } = getConfig();
  try {
    const res = await fetch(`${googleAriBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
        // Authenticates us to the egress proxy (ignored on a direct-to-Google push).
        ...(googleAriProxyKey ? { "X-Ari-Proxy-Key": googleAriProxyKey } : {}),
      },
      body: xml,
    });
    const body = (await res.text().catch(() => "")).trim();
    const errored = /<Error|<Issue|status="?fail|>\s*fail/i.test(body);
    const ok = res.ok && !errored;
    const detail = `HTTP ${res.status}${body ? ` — ${body.slice(0, 400)}` : ""}`;
    return { kind, ok, detail };
  } catch (e) {
    return { kind, ok: false, detail: e instanceof Error ? e.message : "request failed" };
  }
}

/** True + envelope when this property is configured and ready to push; otherwise
 *  a single failed result explaining why (so callers can short-circuit). */
async function envelopeFor(
  pid: string,
  kind: string,
): Promise<
  | { ok: true; env: (k: string) => AriEnvelope; settings: SiteSettings }
  | { ok: false; result: AriPushResult }
> {
  const { googleAriPartnerKey } = getConfig();
  const settings = await getSettings(pid);
  if (!settings.googleAriPush) {
    return { ok: false, result: { kind, ok: false, detail: "Google ARI push is disabled for this property." } };
  }
  if (!googleAriPartnerKey) {
    return { ok: false, result: { kind, ok: false, detail: "GOOGLE_ARI_PARTNER_KEY is not configured." } };
  }
  const readiness = await checkGoogleReadiness(pid);
  if (!readiness.ready) {
    const missing = readiness.missingRequired.map((m) => m.label).join(", ");
    return { ok: false, result: { kind, ok: false, detail: `Property not ready — missing: ${missing}` } };
  }
  const partner = googleAriPartnerKey;
  return {
    ok: true,
    settings,
    env: (k: string) => ({ partner, hotelId: pid, id: messageId(k), timestamp: nowTimestamp() }),
  };
}

/** Property Data (Transaction): rooms + rate plans + their mapping. */
export async function syncPropertyData(pid: string): Promise<AriPushResult> {
  const gate = await envelopeFor(pid, "property_data");
  if (!gate.ok) return gate.result;

  const [rooms, rates, settings] = await Promise.all([getRooms(pid), getRates(pid), getSettings(pid)]);
  const active = rates.filter((r) => r.active);
  const propRooms: PropertyRoom[] = rooms.map((room) => ({
    id: room.id,
    title: room.title,
    description: room.description,
    maxAdults: room.maxAdults,
    maxGuests: room.maxGuests,
    packageIds: active.filter((r) => r.prices[room.id] !== undefined).map((r) => r.id),
  }));
  const propRates: PropertyRate[] = active
    .map((r) => ({
      id: r.id,
      title: r.title,
      roomIds: rooms.filter((room) => r.prices[room.id] !== undefined).map((room) => room.id),
    }))
    .filter((r) => r.roomIds.length > 0);

  const xml = buildPropertyDataXml(gate.env("property_data"), propRooms, propRates, {
    checkin: settings.checkinTime,
    checkout: settings.checkoutTime,
  });
  return postToGoogleAri("property_data", ARI_PATHS.propertyData, xml);
}

/** Rates + availability/restrictions + inventory counts. These three are pushed
 *  together (one inventory read) since they describe the same product grid. */
export async function syncAri(pid: string): Promise<AriPushResult[]> {
  const gate = await envelopeFor(pid, "ari");
  if (!gate.ok) return [gate.result];
  const window = ariWindow(gate.settings.googleAriWindowDays ?? 365);
  const { rates, avail, inventory } = await collectAri(pid, window);
  const out: AriPushResult[] = [];
  out.push(await postToGoogleAri("rate", ARI_PATHS.rate, buildRateAmountXml(gate.env("rate"), rates)));
  out.push(await postToGoogleAri("avail", ARI_PATHS.avail, buildAvailXml(gate.env("avail"), avail)));
  out.push(await postToGoogleAri("inventory", ARI_PATHS.inventory, buildInvCountXml(gate.env("inventory"), inventory)));
  return out;
}

/** TaxFeeInfo: VAT + fees + city tax so Google composes the all-in price. */
export async function syncTaxes(pid: string): Promise<AriPushResult> {
  const gate = await envelopeFor(pid, "taxes");
  if (!gate.ok) return gate.result;
  const { taxes, fees } = googleTaxLines(gate.settings);
  const xml = buildTaxesXml(gate.env("taxes"), taxes, fees);
  return postToGoogleAri("taxes", ARI_PATHS.taxes, xml);
}

/** Promotions: every auto-offer as a non-combinable Google promotion. */
export async function syncPromotions(pid: string): Promise<AriPushResult> {
  const gate = await envelopeFor(pid, "promotions");
  if (!gate.ok) return gate.result;
  const promos = await googlePromotions(pid);
  const xml = buildPromotionsXml(gate.env("promotions"), promos);
  return postToGoogleAri("promotions", ARI_PATHS.promotions, xml);
}

/** The push groups the admin can trigger. "ari" fans out to rate/avail/inventory. */
export type SyncKind = "property_data" | "ari" | "taxes" | "promotions";
export const ALL_SYNC_KINDS: SyncKind[] = ["property_data", "ari", "taxes", "promotions"];

/** Run the given syncs, record the combined outcome on the property, and return
 *  the per-message results. */
export async function runAndRecord(pid: string, kinds: SyncKind[]): Promise<AriPushResult[]> {
  const results: AriPushResult[] = [];
  for (const kind of kinds) {
    if (kind === "property_data") results.push(await syncPropertyData(pid));
    else if (kind === "ari") results.push(...(await syncAri(pid)));
    else if (kind === "taxes") results.push(await syncTaxes(pid));
    else if (kind === "promotions") results.push(await syncPromotions(pid));
  }
  await recordGoogleAriSync(pid, { at: nowTimestamp(), results });
  return results;
}

/** Fire-and-forget push after a data change: no-op unless the property has ARI
 *  push enabled, and never blocks the caller — the work is kept alive past the
 *  response via waitUntil (falling back to a floating promise if unavailable, e.g.
 *  dev). Used by the Channex change webhook and admin edits. */
export async function queueGoogleAriPush(pid: string, kinds: SyncKind[]): Promise<void> {
  if (!(await getSettings(pid)).googleAriPush) return;
  const work = runAndRecord(pid, kinds).catch((e) =>
    console.log(`[google-ari] push failed for ${pid}: ${e instanceof Error ? e.message : e}`),
  );
  try {
    waitUntil(work);
  } catch {
    void work; // outside a request context (or dev): let it run detached
  }
}

/** Cron entry: push everything for every property that has ARI push enabled.
 *  Each property is isolated so one failure doesn't stop the sweep. */
export async function scheduledGoogleAriSync(): Promise<void> {
  const properties = await getProperties();
  for (const p of properties) {
    if (!(await getSettings(p.id)).googleAriPush) continue;
    try {
      await runAndRecord(p.id, ALL_SYNC_KINDS);
    } catch (e) {
      console.log(`[google-ari] scheduled sync failed for ${p.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
