// Google Hotels ARI — transport + per-property push orchestration.
//
// Push model: we POST OTA/Transaction XML to Google's whitelisted upload
// endpoints (auth is IP-whitelist based — no key/secret in the request). Google
// answers 200 with an OTA body describing success or errors. Best-effort: these
// never throw into callers; every push returns a structured result and the
// outcome is recorded on the property so the admin can show it.
import { getConfig } from "../config.server";
import { getRooms, getRates } from "../catalog.server";
import { checkGoogleReadiness } from "../google-readiness.server";
import { getSettings, recordGoogleAriSync } from "../overrides.server";
import { buildPropertyDataXml, type AriEnvelope, type PropertyRoom, type PropertyRate } from "./xml";

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
  const { googleAriBaseUrl } = getConfig();
  try {
    const res = await fetch(`${googleAriBaseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
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
): Promise<{ ok: true; env: (k: string) => AriEnvelope } | { ok: false; result: AriPushResult }> {
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

/** The push kinds available today. PR2 adds rate/avail/inventory/taxes/promotions. */
export type SyncKind = "property_data";
export const ALL_SYNC_KINDS: SyncKind[] = ["property_data"];

/** Run the given syncs, record the combined outcome on the property, and return
 *  the per-message results. */
export async function runAndRecord(pid: string, kinds: SyncKind[]): Promise<AriPushResult[]> {
  const results: AriPushResult[] = [];
  for (const kind of kinds) {
    if (kind === "property_data") results.push(await syncPropertyData(pid));
  }
  await recordGoogleAriSync(pid, { at: nowTimestamp(), results });
  return results;
}
