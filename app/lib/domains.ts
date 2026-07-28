// Custom-domain helpers (pure — safe on the client).
//
// A hotel points their own hostname at us with a CNAME. We store what they
// typed, tell them the record to create, and can check what DNS actually says.
// Provisioning the hostname on the Cloudflare side is a separate step.

/** Strip anything a hotel is likely to paste around a hostname: a scheme, a
 *  path, a port, a trailing dot, stray whitespace, uppercase. */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split("/")[0].split("?")[0].split("#")[0]; // path/query/fragment
  s = s.split("@").pop() ?? s; // someone pasting an email-ish string
  s = s.split(":")[0]; // port
  return s.replace(/\.+$/, ""); // trailing dot
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A human-readable problem with `domain`, or null when it's usable.
 *  `ownHosts` are our own hostnames — pointing one of those at us is a loop. */
export function domainError(domain: string, ownHosts: string[] = []): string | null {
  if (!domain) return "Enter a domain.";
  if (domain.length > 253) return "That domain is too long.";
  const labels = domain.split(".");
  if (labels.length < 2) return "Enter a full domain, like www.yourhotel.com.";
  for (const l of labels) {
    if (!LABEL.test(l)) return `"${domain}" isn't a valid domain name.`;
  }
  // A bare TLD-looking last label with digits is almost always a typo'd IP.
  if (/^\d+$/.test(labels[labels.length - 1])) return "Enter a domain name, not an IP address.";
  if (ownHosts.some((h) => h && domain === h.toLowerCase())) {
    return "That's already our own address — enter the hotel's own domain.";
  }
  return null;
}

/** `www.x.com` is definitely a subdomain. Anything else MIGHT be a root domain,
 *  and we can't tell without the public suffix list (yourhotel.co.uk is a root
 *  domain with three labels). So we under-claim and let the copy say "if this
 *  is your root domain" rather than asserting it is. */
export function isWwwSubdomain(domain: string): boolean {
  return domain.startsWith("www.");
}

export type DnsVerdict =
  /** A CNAME exists and points at our target. */
  | { kind: "points_here"; target: string }
  /** A CNAME exists but points somewhere else. */
  | { kind: "points_elsewhere"; target: string }
  /** No CNAME, but the name resolves — e.g. A records, which is what Cloudflare
   *  CNAME-flattening looks like from outside, and also what a wrong A record
   *  looks like. We can't tell those apart from here, so we don't guess. */
  | { kind: "resolves_without_cname"; addresses: string[] }
  /** The name doesn't resolve at all yet. */
  | { kind: "not_found" }
  /** The lookup itself failed — say so rather than implying the DNS is wrong. */
  | { kind: "check_failed"; reason: string };

/** Compare two hostnames the way DNS means them: case-insensitive, trailing
 *  dot optional. */
export function sameHost(a: string, b: string): boolean {
  return normalizeDomain(a) === normalizeDomain(b) && normalizeDomain(a) !== "";
}
