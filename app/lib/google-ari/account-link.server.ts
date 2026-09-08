// Google Ads ↔ Hotel Center account links (Travel Partner API
// `accounts.accountLinks`). Lets a hotel run PAID Hotel campaigns for its
// property from ITS OWN Google Ads account: we link our Hotel Center account
// (which holds the property's prices + landing pages) to their Ads customer id,
// scoped to just their hotel id. Google then asks the hotel to approve the link
// inside Google Ads; once APPROVED the Hotel campaign type unlocks for them.
// See docs/google-ads-link.md.
//
// Google's model is ONE link per (Hotel Center account, Ads customer) pair, and
// a link does not report which Ads customer it belongs to — so when a second
// property of the same customer links, we must find the existing link (our KV
// registry) and PATCH its hotel list rather than create another, and unlinking
// only DELETEs once no hotel is left on it.
import { getConfig, getConfigKV } from "../config.server";
import { getProperties } from "../properties.server";
import { clearSettingsFields, getSettings, patchSettings } from "../overrides.server";
import { getAccessToken, TRAVEL_PARTNER_API } from "./status.server";
import {
  linkStateOf,
  normalizeGoogleAdsCustomerId,
  type GoogleAdsLinkRecord,
  type GoogleAdsLinkStatus,
} from "./account-link";

export type { GoogleAdsLinkRecord } from "./account-link";

interface AccountLink {
  name?: string;
  status?: GoogleAdsLinkStatus;
  accountLinkTarget?: { allHotels?: boolean; hotelList?: { partnerHotelIds?: string[] } };
}

export type LinkResult =
  | { ok: true; link: GoogleAdsLinkRecord }
  | { ok: false; error: string };

export type RefreshResult =
  | { ok: true; link: GoogleAdsLinkRecord }
  /** Google no longer has the link (removed in Google Ads / Hotel Center); we cleared ours. */
  | { ok: true; link: null; removed: true }
  | { ok: false; error: string };

/** Customer id → link name, so a second property of the same hotel group joins
 *  the existing link instead of tripping Google's one-link-per-pair rule. One
 *  key per customer (a value, not a list) so concurrent writers can't drop
 *  entries; two properties of one customer linking in the same second is the
 *  residual race and it surfaces as a Google ALREADY_EXISTS error, not silent loss. */
const registryKey = (customerId: string) => `google:adslink:${customerId}`;

async function registryGet(customerId: string): Promise<string | null> {
  try {
    return await getConfigKV().get(registryKey(customerId));
  } catch {
    return null;
  }
}
async function registryPut(customerId: string, name: string): Promise<void> {
  try {
    await getConfigKV().put(registryKey(customerId), name);
  } catch {
    // Losing the registry only costs a duplicate-link error next time.
  }
}
async function registryDelete(customerId: string): Promise<void> {
  try {
    await getConfigKV().delete(registryKey(customerId));
  } catch {
    /* ignore */
  }
}

/** Is the Travel Partner side configured at all (secrets present)? */
export function googleAdsLinkingAvailable(): boolean {
  const c = getConfig();
  return Boolean(c.googleTravelPartnerAccountId && c.googleTravelPartnerSaEmail && c.googleTravelPartnerSaKey);
}

// ---- one thin transport, so every call reports Google's message the same way ----
type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

function describeGoogleError(status: number, body: string): string {
  let msg = "";
  let code = "";
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string } };
    msg = j.error?.message ?? "";
    code = j.error?.status ?? "";
  } catch {
    msg = body.slice(0, 200);
  }
  if (status === 403) {
    return (
      `Google refused access (${code || 403}). The Hotel Center service account can read the account ` +
      `but may lack Owner permission to manage account links — grant it in Hotel Center → Users. ` +
      (msg ? `Google said: ${msg}` : "")
    ).trim();
  }
  return `Google rejected the request (${code || status})${msg ? `: ${msg}` : "."}`;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const token = await getAccessToken();
  if (!token) return { ok: false, status: 0, error: "Couldn't authenticate to Google's Travel Partner API (check the service-account secrets)." };
  let res: Response;
  try {
    res = await fetch(`${TRAVEL_PARTNER_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.log(`[travelpartner] ${method} ${path} failed: ${m}`);
    return { ok: false, status: 0, error: `Couldn't reach Google (${m}).` };
  }
  const text = await res.text();
  if (!res.ok) {
    console.log(`[travelpartner] ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
    return { ok: false, status: res.status, error: describeGoogleError(res.status, text) };
  }
  let data: T;
  try {
    data = (text ? JSON.parse(text) : {}) as T;
  } catch {
    data = {} as T;
  }
  return { ok: true, data };
}

const accountPath = () => `/accounts/${encodeURIComponent(getConfig().googleTravelPartnerAccountId ?? "")}`;

function hotelIdsOf(link: AccountLink): string[] {
  return link.accountLinkTarget?.hotelList?.partnerHotelIds ?? [];
}

function record(customerId: string, name: string, status: string | undefined, createdAt: number): GoogleAdsLinkRecord {
  return {
    customerId,
    name,
    status: (status as GoogleAdsLinkStatus) || "ACCOUNT_LINK_STATUS_UNKNOWN",
    createdAt,
    checkedAt: Date.now(),
  };
}

/**
 * Link the property to a Google Ads customer. Creates the Hotel Center → Ads
 * link scoped to this property's hotel id (= the property id, same key as the
 * feed/JSON-LD/ARI), or joins the customer's existing link when another of
 * their properties already made one. The hotel then approves in Google Ads.
 */
export async function linkGoogleAds(propertyId: string, rawCustomerId: unknown): Promise<LinkResult> {
  const customerId = normalizeGoogleAdsCustomerId(rawCustomerId);
  if (!customerId) return { ok: false, error: "Enter the 10-digit Google Ads customer ID (e.g. 123-456-7890)." };
  if (!googleAdsLinkingAvailable()) return { ok: false, error: "Google Ads linking isn't configured on this server yet." };
  const settings = await getSettings(propertyId);
  if (settings.googleAdsLink) return { ok: false, error: "This property is already linked to a Google Ads account. Unlink it first." };
  if (settings.googleProgram === "vacation_rentals") {
    return { ok: false, error: "Google Ads linking is for the Hotel Center program; this property pushes to Vacation Rentals." };
  }

  // Another of this customer's properties may already hold the link: extend it.
  const existingName = await registryGet(customerId);
  if (existingName) {
    const cur = await api<AccountLink>("GET", `/${existingName}`);
    if (cur.ok) {
      const ids = hotelIdsOf(cur.data);
      if (cur.data.accountLinkTarget?.allHotels) {
        return { ok: false, error: "This Google Ads account is linked to ALL our properties in Hotel Center — a per-property link can't be added. Contact support." };
      }
      if (!ids.includes(propertyId)) {
        const upd = await api<AccountLink>(
          "PATCH",
          `/${existingName}?updateMask=${encodeURIComponent("accountLink.account_link_target")}`,
          { accountLinkTarget: { hotelList: { partnerHotelIds: [...ids, propertyId] } } },
        );
        if (!upd.ok) return { ok: false, error: upd.error };
      }
      const link = record(customerId, existingName, cur.data.status, Date.now());
      await patchSettings(propertyId, { googleAdsLink: link });
      return { ok: true, link };
    }
    if (cur.status !== 404) return { ok: false, error: cur.error };
    await registryDelete(customerId); // stale registry — the link was removed; create afresh
  }

  const created = await api<AccountLink>("POST", `${accountPath()}/accountLinks`, {
    googleAdsCustomerName: `customers/${customerId}`,
    accountLinkTarget: { hotelList: { partnerHotelIds: [propertyId] } },
  });
  if (!created.ok) {
    if (created.status === 409) {
      return {
        ok: false,
        error:
          "Google says this Ads account is already linked to our Hotel Center account (probably set up by hand). " +
          "Ask us to add this property to that link, or remove the old link in Google Ads → Data manager first.",
      };
    }
    return { ok: false, error: created.error };
  }
  const name = created.data.name;
  if (!name) return { ok: false, error: "Google created the link but returned no resource name — try Check status in a minute." };
  await registryPut(customerId, name);
  const link = record(customerId, name, created.data.status ?? "REQUESTED_FROM_HOTEL_CENTER", Date.now());
  await patchSettings(propertyId, { googleAdsLink: link });
  return { ok: true, link };
}

/** Re-read the link's status from Google and store it. A 404 means the link is
 *  gone (revoked in Google Ads or deleted in Hotel Center): we clear our record. */
export async function refreshGoogleAdsLink(propertyId: string): Promise<RefreshResult> {
  const settings = await getSettings(propertyId);
  const cur = settings.googleAdsLink;
  if (!cur) return { ok: false, error: "This property isn't linked to a Google Ads account." };
  const res = await api<AccountLink>("GET", `/${cur.name}`);
  if (!res.ok) {
    if (res.status === 404) {
      await clearSettingsFields(propertyId, ["googleAdsLink"]);
      await registryDelete(cur.customerId);
      return { ok: true, link: null, removed: true };
    }
    return { ok: false, error: res.error };
  }
  // Also notice when this hotel was dropped from the list on Google's side.
  if (!res.data.accountLinkTarget?.allHotels && !hotelIdsOf(res.data).includes(propertyId)) {
    await clearSettingsFields(propertyId, ["googleAdsLink"]);
    return { ok: true, link: null, removed: true };
  }
  const link: GoogleAdsLinkRecord = { ...cur, status: res.data.status ?? cur.status, checkedAt: Date.now() };
  await patchSettings(propertyId, { googleAdsLink: link });
  return { ok: true, link };
}

/** Remove this property from its Google Ads link: PATCH it off the hotel list
 *  when the customer's other properties stay linked, DELETE the link when it was
 *  the last one. Our record is cleared either way. */
export async function unlinkGoogleAds(propertyId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = await getSettings(propertyId);
  const cur = settings.googleAdsLink;
  if (!cur) return { ok: true };
  const got = await api<AccountLink>("GET", `/${cur.name}`);
  if (!got.ok && got.status !== 404) return { ok: false, error: got.error };
  if (got.ok) {
    const remaining = hotelIdsOf(got.data).filter((id) => id !== propertyId);
    if (remaining.length > 0 && !got.data.accountLinkTarget?.allHotels) {
      const upd = await api<AccountLink>(
        "PATCH",
        `/${cur.name}?updateMask=${encodeURIComponent("accountLink.account_link_target")}`,
        { accountLinkTarget: { hotelList: { partnerHotelIds: remaining } } },
      );
      if (!upd.ok) return { ok: false, error: upd.error };
    } else {
      const del = await api<unknown>("DELETE", `/${cur.name}`);
      if (!del.ok && del.status !== 404) return { ok: false, error: del.error };
      await registryDelete(cur.customerId);
    }
  } else {
    await registryDelete(cur.customerId);
  }
  await clearSettingsFields(propertyId, ["googleAdsLink"]);
  return { ok: true };
}

// Cron: pending links are re-checked hourly-ish (the hotel's approval is the
// event we're waiting for), approved ones ~daily (a revoke is rare). Both go
// through the same 6h cron, so "hourly" is really "every run".
const PENDING_RECHECK_MS = 60 * 60 * 1000;
const APPROVED_RECHECK_MS = 20 * 60 * 60 * 1000;

export async function refreshPendingGoogleAdsLinks(): Promise<void> {
  if (!googleAdsLinkingAvailable()) return;
  let properties: { id: string }[] = [];
  try {
    properties = await getProperties();
  } catch (e) {
    console.log(`[travelpartner] adslinks: couldn't list properties: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const now = Date.now();
  for (const p of properties) {
    let link: GoogleAdsLinkRecord | undefined;
    try {
      link = (await getSettings(p.id)).googleAdsLink;
    } catch {
      continue;
    }
    if (!link) continue;
    const maxAge = linkStateOf(link.status) === "approved" ? APPROVED_RECHECK_MS : PENDING_RECHECK_MS;
    if (now - link.checkedAt < maxAge) continue;
    await refreshGoogleAdsLink(p.id).catch(() => undefined);
  }
}
