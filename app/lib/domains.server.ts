// Live DNS lookup for custom domains, over Cloudflare's DNS-over-HTTPS resolver.
//
// This tells the hotel what their DNS ACTUALLY says right now, which is the
// question they're really asking when a domain "isn't working". It does not
// provision anything: activating the hostname on our side is a separate step,
// and the admin page says so rather than implying a green tick means live.

import { getConfig, getConfigKV } from "./config.server";
import { normalizeDomain, sameHost, type DnsVerdict } from "./domains";

// ===== hostname -> property index =====
//
// A guest arriving on www.spilmanhotel.co.uk carries no property in the URL, so
// the hostname has to identify it. That lookup happens on the request path, so
// it is a single KV read keyed by the hostname itself.
//
// ONE KEY PER HOSTNAME, deliberately — not a single `domains` map. A map would
// mean read-modify-write on every save, and two properties saving a domain at
// the same time would silently drop one of them. Per-key writes cannot collide.
//
// The index is derived state: `settings.websiteDomain` is the source of truth.
// It is maintained on save rather than rebuilt on read, and a rename releases the
// previous hostname so it cannot leave a stale entry pointing at a property that
// no longer answers for it.
//
// TWO keys per hostname, with different meanings:
//
//   domain:{host}        this property IS served here. Read on the request path.
//   domain-setup:{host}  this property is ALLOWED to set this hostname up.
//
// The split exists because typing a domain into a form proves nothing. A save
// takes the setup reservation; the live key is only written once Cloudflare
// confirms the hotel controls the hostname (see custom-hostnames.server.ts).
// Without the reservation, two properties could both enter the same domain and
// whichever polled first after the real owner added the TXT record would win it —
// so the reservation is what makes the ownership proof land on the right tenant.

const domainKey = (host: string) => `domain:${host}`;
const SETUP_PREFIX = "domain-setup:";
const setupKey = (host: string) => `${SETUP_PREFIX}${host}`;

/** A reservation lapses if ownership is never proven, so an abandoned attempt
 *  can't park a domain nobody can then claim. Saving again renews it. */
const SETUP_TTL_SECONDS = 60 * 60 * 24 * 30;

/** The property serving `hostname`, or null if no hotel has claimed it. */
export async function propertyIdForHost(hostname: string): Promise<string | null> {
  const host = normalizeDomain(hostname);
  if (!host) return null;
  // Our own address is never a hotel's custom domain. Guarding here as well as
  // on save means a bad index entry still can't hijack the shared domain.
  if (isOwnHost(host)) return null;
  const kv = getConfigKV();
  if (!kv) return null;
  return (await kv.get(domainKey(host))) || null;
}

/**
 * True when `host` is an address of ours rather than a hotel's own domain.
 *
 * Covers the app's own hostname, the CNAME target hotels point at (claiming the
 * fallback origin itself would be a self-inflicted outage), Workers preview
 * URLs, and localhost.
 *
 * Deliberately NOT "anything under our registrable domain". Deriving that from
 * `book.roompanda.com` means taking the last two labels, which is right for
 * .com and catastrophically wrong for a .co.uk app hostname — it would reject
 * every hotel domain in the UK. Extra hosts of ours belong in OWN_HOSTS, listed
 * explicitly, rather than guessed with a heuristic that has no public suffix
 * list behind it.
 */
export function isOwnHost(host: string): boolean {
  const h = normalizeDomain(host);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".workers.dev")) return true;
  const config = getConfig();
  const own = new Set<string>();
  try {
    own.add(normalizeDomain(new URL(config.appUrl).hostname));
  } catch {
    /* malformed APP_URL — fall through to the rest */
  }
  if (config.customHostnameTarget) own.add(normalizeDomain(config.customHostnameTarget));
  for (const extra of (config.ownHosts ?? "").split(",")) {
    const e = normalizeDomain(extra);
    if (e) own.add(e);
  }
  own.delete("");
  return own.has(h);
}

/**
 * Refuse to serve this request unless it arrived on one of our own hostnames.
 *
 * The Cloudflare for SaaS setup routes EVERY custom hostname to this Worker
 * through a single wildcard Worker route, so without this the admin panel, /v1,
 * /mcp and the feeds are all reachable at `https://www.anyhotel.co.uk/admin` —
 * our login
 * form served on a domain the hotel (and their DNS provider, and anyone able to
 * tamper with their zone) controls. That is a credential-phishing surface handed
 * to every tenant.
 *
 * 404 rather than a redirect: a redirect would confirm the path exists and hand
 * over the canonical URL, and there is no legitimate reason for these routes to
 * be discoverable on a hotel's domain at all.
 *
 * Guest routes deliberately do NOT call this — serving them on a hotel's own
 * hostname is the entire feature.
 */
export function requireCanonicalHost(request: Request): void {
  let host = "";
  try {
    host = new URL(request.url).hostname;
  } catch {
    throw new Response("Not found", { status: 404 });
  }
  if (!isOwnHost(host)) throw new Response("Not found", { status: 404 });
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: "own_host" }
  /** Another property already serves this hostname. */
  | { ok: false; reason: "taken"; propertyId: string };

/**
 * Write `key` = `pid`, refusing if another property already holds it.
 *
 * KV has no compare-and-swap, so the pre-check is a read-then-write with a
 * window: two properties claiming the same free hostname at the same moment both
 * see it unowned and both write. Re-read afterwards and only report success if we
 * are the one that stuck — otherwise the loser's settings would record a domain
 * the index points somewhere else.
 */
async function claimKey(key: string, pid: string, ttl?: number): Promise<ClaimResult> {
  const kv = getConfigKV();
  if (!kv) return { ok: true };
  const owner = await kv.get(key);
  if (owner && owner !== pid) return { ok: false, reason: "taken", propertyId: owner };
  await kv.put(key, pid, ttl ? { expirationTtl: ttl } : undefined);
  const settled = await kv.get(key);
  if (settled && settled !== pid) return { ok: false, reason: "taken", propertyId: settled };
  return { ok: true };
}

/**
 * Reserve `domain` for `pid` so it can be set up — NOT yet served.
 *
 * Refuses a hostname another property is already serving or already setting up.
 * Serving starts at `activateDomain`, once ownership is proven.
 */
export async function claimDomainSetup(pid: string, domain: string): Promise<ClaimResult> {
  const host = normalizeDomain(domain);
  if (!host) return { ok: true };
  if (isOwnHost(host)) return { ok: false, reason: "own_host" };
  const kv = getConfigKV();
  // A hostname someone else is live on is taken regardless of reservations.
  const live = kv ? await kv.get(domainKey(host)) : null;
  if (live && live !== pid) return { ok: false, reason: "taken", propertyId: live };
  return claimKey(setupKey(host), pid, SETUP_TTL_SECONDS);
}

/**
 * Start serving `domain` from `pid`. Call this ONLY with proof of ownership.
 *
 * A hostname can serve exactly one property — letting two claim it would make
 * which hotel a guest sees depend on KV read order.
 */
export async function activateDomain(pid: string, domain: string): Promise<ClaimResult> {
  const host = normalizeDomain(domain);
  if (!host) return { ok: true };
  if (isOwnHost(host)) return { ok: false, reason: "own_host" };
  const kv = getConfigKV();
  // The reservation is what ties the proof to a tenant: Cloudflare verifies the
  // DOMAIN, not who asked, so without this any property could ride on the real
  // owner's TXT record by polling first.
  const reserved = kv ? await kv.get(setupKey(host)) : null;
  const live = kv ? await kv.get(domainKey(host)) : null;
  if (reserved && reserved !== pid) return { ok: false, reason: "taken", propertyId: reserved };
  // Claims made before this gate existed have a live key and no reservation;
  // they stay valid rather than needing every hotel to re-verify.
  if (!reserved && live !== pid) return { ok: false, reason: "taken", propertyId: live ?? "" };
  return claimKey(domainKey(host), pid);
}

/** Who is allowed to set `hostname` up, if anyone. */
export async function domainSetupOwner(hostname: string): Promise<string | null> {
  const host = normalizeDomain(hostname);
  const kv = getConfigKV();
  if (!host || !kv) return null;
  return (await kv.get(setupKey(host))) || null;
}

/**
 * Drop `pid`'s claim on `domain`, live and reserved. Returns true if anything was
 * actually removed — the caller uses that as its authority to tear down the
 * Cloudflare hostname too.
 *
 * Scoped to the owner deliberately: a property's stored `websiteDomain` can name
 * a hostname it does not actually hold (a clone used to inherit one), and
 * deleting on the strength of that would take the real holder's site down.
 */
export async function releaseDomain(pid: string, domain: string | undefined): Promise<boolean> {
  const host = normalizeDomain(domain ?? "");
  const kv = getConfigKV();
  if (!host || !kv) return false;
  let released = false;
  for (const key of [domainKey(host), setupKey(host)]) {
    if ((await kv.get(key)) === pid) {
      await kv.delete(key);
      released = true;
    }
  }
  return released;
}

/**
 * Hostnames reserved by a property but not yet live — what the cron re-checks.
 *
 * Bounded by `limit`: this runs on a schedule, and an unbounded scan would grow
 * with the tenant count until it ate the cron's time budget.
 */
export async function pendingDomainSetups(
  limit = 100,
): Promise<{ host: string; propertyId: string }[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const listed = await kv.list({ prefix: SETUP_PREFIX, limit });
  const out: { host: string; propertyId: string }[] = [];
  for (const key of listed.keys) {
    const host = key.name.slice(SETUP_PREFIX.length);
    if (!host) continue;
    const [propertyId, live] = await Promise.all([kv.get(key.name), kv.get(domainKey(host))]);
    if (propertyId && !live) out.push({ host, propertyId });
  }
  return out;
}

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const TIMEOUT_MS = 5000;

// DNS record type numbers we care about in the JSON answer.
const TYPE_A = 1;
const TYPE_CNAME = 5;
const TYPE_AAAA = 28;

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}
interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

async function query(name: string, type: "CNAME" | "A"): Promise<DohResponse | null> {
  const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as DohResponse;
  } catch {
    return null;
  }
}

/** What `domain` currently resolves to, judged against our CNAME `target`. */
export async function checkDns(domain: string, target: string): Promise<DnsVerdict> {
  if (!domain) return { kind: "check_failed", reason: "No domain set." };
  if (!target) return { kind: "check_failed", reason: "No CNAME target configured." };

  const cname = await query(domain, "CNAME");
  if (!cname) return { kind: "check_failed", reason: "Couldn't reach the DNS resolver." };

  const cnameRecords = (cname.Answer ?? []).filter((a) => a.type === TYPE_CNAME);
  if (cnameRecords.length) {
    // Follow the chain to its end — a hotel may CNAME through their own alias.
    const last = cnameRecords[cnameRecords.length - 1].data;
    return sameHost(last, target)
      ? { kind: "points_here", target: last.replace(/\.$/, "") }
      : { kind: "points_elsewhere", target: last.replace(/\.$/, "") };
  }

  // No CNAME. Does it resolve at all? Cloudflare CNAME-flattening on the
  // hotel's own zone answers with A records, and so does a plain wrong A
  // record — indistinguishable from out here, so report, don't conclude.
  const a = await query(domain, "A");
  const addresses = (a?.Answer ?? [])
    .filter((r) => r.type === TYPE_A || r.type === TYPE_AAAA)
    .map((r) => r.data);
  if (addresses.length) return { kind: "resolves_without_cname", addresses };

  // NXDOMAIN (3) or an empty answer both mean "nothing there yet".
  return { kind: "not_found" };
}
