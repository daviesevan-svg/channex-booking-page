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
  //
  // `previous` is caller-supplied and MUST NOT be trusted: only drop the old
  // entry when it actually points at this property. Without that check, passing
  // someone else's hostname as `previous` deletes their claim — their site goes
  // dark and the domain becomes claimable by anyone. That was reachable through
  // cloneProperty, which copied `websiteDomain` onto the clone, so editing the
  // clone's domain released the original's live one.
  if (old && old !== host && (await kv.get(domainKey(old))) === pid) {
    await kv.delete(domainKey(old));
  }

  if (host) {
    await kv.put(domainKey(host), pid);
    // KV has no compare-and-swap, so the check above is a read-then-write with a
    // window: two properties claiming the same free hostname at the same moment
    // both see it unowned and both write. Re-read and only report success if we
    // are the one that stuck — otherwise the loser's settings would record a
    // domain the index points somewhere else.
    const settled = await kv.get(domainKey(host));
    if (settled && settled !== pid) {
      return { ok: false, reason: "taken", propertyId: settled };
    }
  }
  return { ok: true };
}

/**
 * Drop `pid`'s claim on `domain` — used when the property itself is removed.
 *
 * Scoped to the owner for the same reason as `claimDomain`: a property's stored
 * `websiteDomain` can name a hostname it does not actually hold (a clone used to
 * inherit one), and deleting on the strength of that would take the real
 * holder's site down.
 */
export async function releaseDomain(pid: string, domain: string | undefined): Promise<void> {
  const host = normalizeDomain(domain ?? "");
  const kv = getConfigKV();
  if (!host || !kv) return;
  if ((await kv.get(domainKey(host))) === pid) await kv.delete(domainKey(host));
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
