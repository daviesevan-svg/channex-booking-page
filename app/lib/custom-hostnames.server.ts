// Cloudflare for SaaS custom hostnames — the provisioning half of custom domains.
//
// A hotel's own hostname serves their site only once three things are true:
//
//   1. their DNS points the hostname at our CNAME target   (they do this)
//   2. Cloudflare has the hostname on our zone, with a cert (this file)
//   3. our KV index maps the hostname to their property     (domains.server.ts)
//
// (2) is also the proof of ownership for (3). Cloudflare marks a custom hostname
// `active` only once the hostname either CNAMEs into our zone or carries the
// ownership TXT record Cloudflare issued for it — both require control of the
// domain. So the KV claim is written from Cloudflare's verdict rather than from
// what someone typed into a form. That is what closes the hole a save-time-only
// check leaves open: nothing stops a tenant typing `marriott.com`, and before
// this the index would happily record it.
//
// Validation is CNAME + automatic HTTP DCV, so the hotel adds ONE record and
// nothing else. Both of Cloudflare's checks then complete on their own:
// ownership, because the hostname now CNAMEs into our zone, and the certificate,
// because Cloudflare can serve the CA's token from the edge once traffic arrives.
//
// The known cost, accepted deliberately (Evan, 2026-07-30): the certificate can
// only be issued AFTER the CNAME points here, so there is a window — usually
// minutes — where the hotel's domain resolves to us without a valid cert and
// browsers warn. Pre-issuing would remove it, but only by asking every hotel for
// a TXT record (or a permanent `_acme-challenge` CNAME via delegated DCV), and
// one record beats two for hotels who are pointing a domain that isn't live yet.
// If we ever onboard a hotel migrating an already-live site, THAT is when to add
// pre-validation — for them the window is a real outage, not a blank domain.
//
// We deliberately do NOT use Cloudflare's per-hostname `custom_metadata` to carry
// the property id, even though `request.cf.hostMetadata` would make it readable
// on the request path. KV is the index; a second copy at the edge would be a
// second source of truth to drift.

import { getConfig } from "./config.server";
import { activateDomain, pendingDomainSetups } from "./domains.server";
import { normalizeDomain } from "./domains";

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 8000;

export type ProvisionState =
  /** No API credentials on this deployment: custom domains can't be activated. */
  | { kind: "off" }
  /** Configured, but this hostname hasn't been registered with Cloudflare yet. */
  | { kind: "missing" }
  /** The API call itself failed — say so rather than implying the domain is wrong. */
  | { kind: "error"; message: string }
  | {
      kind: "hostname";
      id: string;
      /** Cloudflare has proof the hotel controls this hostname. */
      verified: boolean;
      /** The certificate is issued and deployed, so HTTPS actually works. */
      certReady: boolean;
      /** Raw Cloudflare states, shown as-is: they're the useful detail when
       *  something is stuck, and paraphrasing them loses information. */
      status: string;
      certStatus: string;
      /** Validation errors Cloudflare reported, verbatim. The one diagnostic worth
       *  surfacing as-is: "custom hostname does not CNAME to this zone" IS the
       *  answer when a hotel says their domain isn't working. */
      problems: string[];
    };

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

interface CfCustomHostname {
  id: string;
  hostname: string;
  status: string;
  verification_errors?: string[];
  ssl?: {
    status?: string;
    validation_errors?: { message?: string }[];
  };
}

/** True when this deployment can provision hostnames at all. */
export function provisioningConfigured(): boolean {
  const c = getConfig();
  return Boolean(c.cloudflareApiToken && c.cloudflareZoneId);
}

async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const { cloudflareApiToken, cloudflareZoneId } = getConfig();
  if (!cloudflareApiToken || !cloudflareZoneId) throw new Error("Not configured.");
  const res = await fetch(`${API}/zones/${cloudflareZoneId}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cloudflareApiToken}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: CfEnvelope<T> | null = null;
  try {
    body = (await res.json()) as CfEnvelope<T>;
  } catch {
    /* non-JSON body — fall through to the status-based message */
  }
  if (!body?.success) {
    const detail = (body?.errors ?? [])
      .map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(detail || `Cloudflare returned ${res.status}.`);
  }
  return body.result as T;
}

/** Cloudflare reports `active` and `active_redeploying` for a verified hostname. */
function isVerified(h: CfCustomHostname): boolean {
  return (h.status ?? "").startsWith("active");
}

function describe(h: CfCustomHostname): ProvisionState {
  const certStatus = h.ssl?.status ?? "unknown";
  return {
    kind: "hostname",
    id: h.id,
    verified: isVerified(h),
    certReady: certStatus === "active",
    status: h.status ?? "unknown",
    certStatus,
    problems: [
      ...(h.verification_errors ?? []),
      ...(h.ssl?.validation_errors ?? []).map((e) => e.message ?? ""),
    ].filter(Boolean),
  };
}

/** Look up `hostname` without creating anything — safe to call from a loader. */
export async function findCustomHostname(hostname: string): Promise<ProvisionState> {
  const host = normalizeDomain(hostname);
  if (!host) return { kind: "missing" };
  if (!provisioningConfigured()) return { kind: "off" };
  try {
    const list = await cf<CfCustomHostname[]>(
      `/custom_hostnames?hostname=${encodeURIComponent(host)}`,
    );
    // The filter is a prefix match on Cloudflare's side, so confirm the hostname
    // rather than trusting the first row (`hotel.com` also matches `myhotel.com`).
    const match = (list ?? []).find((h) => normalizeDomain(h.hostname) === host);
    return match ? describe(match) : { kind: "missing" };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Register `hostname` with Cloudflare if it isn't already, and report its state.
 *
 * Idempotent: an existing hostname is reused rather than recreated, so this also
 * heals a record deleted by hand in the dashboard.
 */
export async function ensureCustomHostname(hostname: string): Promise<ProvisionState> {
  const host = normalizeDomain(hostname);
  if (!host) return { kind: "missing" };
  if (!provisioningConfigured()) return { kind: "off" };

  const existing = await findCustomHostname(host);
  if (existing.kind !== "missing") return existing;

  try {
    await cf<CfCustomHostname>("/custom_hostnames", {
      method: "POST",
      body: JSON.stringify({
        hostname: host,
        // `certificate_authority` is left unset on purpose: that selects
        // Cloudflare's default CA, which checks CAA records before requesting a
        // cert instead of failing issuance later.
        //
        // method "http" = automatic DCV. Cloudflare serves the CA's token from
        // the edge once the hotel's CNAME points here, so the hotel adds no
        // record beyond that CNAME. See the header note on the TLS window.
        ssl: { method: "http", type: "dv" },
      }),
    });
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }

  // Read back rather than trusting the POST body: the create response reports a
  // just-born hostname, and its status is what the caller acts on. A create that
  // succeeded but reads back as missing is Cloudflare being eventually
  // consistent, not a failure — say "check again", don't re-create.
  return findCustomHostname(host);
}

/** Remove `hostname` from our zone. Callers MUST have verified ownership first. */
export async function deleteCustomHostname(hostname: string): Promise<void> {
  const host = normalizeDomain(hostname);
  if (!host || !provisioningConfigured()) return;
  const state = await findCustomHostname(host);
  if (state.kind !== "hostname") return;
  await cf(`/custom_hostnames/${state.id}`, { method: "DELETE" });
}

/**
 * Switch on every pending domain Cloudflare has since verified.
 *
 * Without this, activation would depend on the hotel coming back to the admin
 * and pressing a button after their DNS propagated — which they don't, so the
 * domain would sit dark with everything in place.
 *
 * Bounded per run: a sweep that grew with the tenant count would eventually eat
 * the cron's time budget.
 */
export async function activateVerifiedDomains(limit = 50): Promise<number> {
  if (!provisioningConfigured()) return 0;
  const pending = await pendingDomainSetups(limit);
  let activated = 0;
  for (const { host, propertyId } of pending) {
    const state = await findCustomHostname(host).catch(() => null);
    if (state?.kind !== "hostname" || !state.verified) continue;
    const claim = await activateDomain(propertyId, host).catch(() => null);
    if (claim?.ok) {
      activated++;
      console.log(`[domains] activated ${host} -> ${propertyId}`);
    }
  }
  return activated;
}
