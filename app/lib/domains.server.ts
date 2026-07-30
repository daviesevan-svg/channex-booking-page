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
// It is maintained on save rather than rebuilt on read, and `claimDomain`
// releases the previous hostname so a rename cannot leave a stale entry
// pointing at a property that no longer answers for it.

const domainKey = (host: string) => `domain:${host}`;

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

/** True when `host` is an address of ours rather than a hotel's own domain. */
export function isOwnHost(host: string): boolean {
  const h = normalizeDomain(host);
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  try {
    return h === normalizeDomain(new URL(getConfig().appUrl).hostname);
  } catch {
    return false;
  }
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: "own_host" }
  /** Another property already serves this hostname. */
  | { ok: false; reason: "taken"; propertyId: string };

/**
 * Point `domain` at `pid`, releasing `previous` if the hotel is renaming.
 *
 * Pass an empty `domain` to only release. A hostname can serve exactly one
 * property — letting two claim it would make which hotel a guest sees depend on
 * KV read order.
 */
export async function claimDomain(
  pid: string,
  domain: string,
  previous?: string,
): Promise<ClaimResult> {
  const kv = getConfigKV();
  const host = normalizeDomain(domain);
  const old = normalizeDomain(previous ?? "");

  if (host && isOwnHost(host)) return { ok: false, reason: "own_host" };
  if (host) {
    const owner = kv ? await kv.get(domainKey(host)) : null;
    if (owner && owner !== pid) return { ok: false, reason: "taken", propertyId: owner };
  }
  if (!kv) return { ok: true };

  // Release first, then claim. The reverse order would briefly leave the old
  // hostname pointing here after the new one already does, and a crash between
  // the two would strand it that way permanently.
  if (old && old !== host) await kv.delete(domainKey(old));
  if (host) await kv.put(domainKey(host), pid);
  return { ok: true };
}

/** Drop a property's claim — used when the property itself is removed. */
export async function releaseDomain(domain: string | undefined): Promise<void> {
  const host = normalizeDomain(domain ?? "");
  const kv = getConfigKV();
  if (host && kv) await kv.delete(domainKey(host));
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
