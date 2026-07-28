// Live DNS lookup for custom domains, over Cloudflare's DNS-over-HTTPS resolver.
//
// This tells the hotel what their DNS ACTUALLY says right now, which is the
// question they're really asking when a domain "isn't working". It does not
// provision anything: activating the hostname on our side is a separate step,
// and the admin page says so rather than implying a green tick means live.

import { sameHost, type DnsVerdict } from "./domains";

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
