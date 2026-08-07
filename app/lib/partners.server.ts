// White-label partners: a PMS reselling the booking engine under its own brand
// (docs/whitelabel.md). A partner is CONFIGURATION over the existing data —
// properties and users gain an optional partnerId; rooms/rates/ARI/bookings
// stay keyed by property id and never learn the word.
//
// Stored one key per partner (`partner:{id}`), like users: KV is eventually
// consistent and concurrent writes to one key overwrite each other, so a shared
// list would drop a partner when two saves race. Per-key writes can't collide.
import { getConfigKV } from "./config.server";
import { domainSetupOwner, isOwnHost, propertyIdForHost } from "./domains.server";
import { normalizeDomain } from "./domains";
import { getUser } from "./users.server";

export interface Partner {
  /** Stable slug id ([a-z0-9-]), chosen at creation, used in KV keys and on
   *  PropertyRef/User.partnerId. Never rename — it's a foreign key. */
  id: string;
  /** Internal name ("HotelSoft Ltd") — superadmin pages only. */
  name: string;
  /** What their users see everywhere we'd otherwise say Roompanda. */
  brandName: string;
  /** Reply-to for operator emails; shown as the support contact. */
  supportEmail?: string;
  /** Route ids their hotel users can't open (enforced in loaders; see
   *  requirePageAllowed). partner_admins bypass this — they chose the list. */
  hiddenPages?: string[];
  /** The partner's own admin hostname (admin.theirpms.com). Once set and
   *  served, it is the ONLY door for their users: sign-in and sessions are
   *  bound to it in both directions (auth.server), and the login page carries
   *  their brand. Kept in a per-host index like property domains — see
   *  claimPartnerAdminHost. */
  adminHost?: string;
  /** The partner's shared guest booking hostname (book.theirpms.com). Slug
   *  paths there serve ONLY this partner's properties, and its root is a
   *  picker of their public ones under their brand (property-scope.server,
   *  picker.server). Per-hotel custom domains keep working independently. */
  guestHost?: string;
  createdAt: number;
}

/** Default preset for a PMS-managed hotel (docs/whitelabel.md §4): the PMS
 *  pre-wires the channel and owns the developer surface; platform features
 *  have no life under a partner. Everything operational stays visible. */
export const DEFAULT_HIDDEN_PAGES = [
  "connectivity",
  "api-keys",
  "webhooks",
  "google-hotels",
  "brand-kit",
  "collections",
] as const;

const PREFIX = "partner:";
const key = (id: string) => `${PREFIX}${id}`;

/** 3–40 chars, lowercase letters/digits/hyphens, no edge hyphens. */
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export function isValidPartnerId(id: string): boolean {
  return ID_RE.test(id);
}

function parse(raw: string | null): Partner | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw);
    return p && typeof p.id === "string" && typeof p.brandName === "string" ? (p as Partner) : undefined;
  } catch {
    return undefined;
  }
}

export async function getPartners(): Promise<Partner[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const out: Partner[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list({ prefix: PREFIX, cursor });
    const raws = await Promise.all(res.keys.map((k) => kv.get(k.name)));
    for (const raw of raws) {
      const p = parse(raw);
      if (p) out.push(p);
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPartner(id: string | undefined): Promise<Partner | undefined> {
  if (!id) return undefined;
  const kv = getConfigKV();
  if (!kv) return undefined;
  return parse(await kv.get(key(id)));
}

export async function savePartner(partner: Partner): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(key(partner.id), JSON.stringify(partner));
}

/** Removes a partner record and releases its host claims. The ROUTE is
 *  responsible for refusing while properties or users still reference the id —
 *  a dangling partnerId would strand them invisible to everyone but
 *  superadmins. */
export async function deletePartner(partner: Partner): Promise<void> {
  await releasePartnerAdminHost(partner.id, partner.adminHost);
  await releasePartnerGuestHost(partner.id, partner.guestHost);
  const kv = getConfigKV();
  if (kv) await kv.delete(key(partner.id));
}

/** The brand context every operator-facing surface resolves through: partner
 *  brand when there is one, our defaults when there isn't. Keep the default in
 *  ONE place so a rebrand of ours is one edit. */
export interface Brand {
  name: string;
  supportEmail?: string;
  /** Set when this is a partner brand (surfaces may behave differently). */
  partnerId?: string;
}

export const DEFAULT_BRAND: Brand = { name: "Roompanda" };

export function brandOf(partner: Partner | undefined): Brand {
  return partner
    ? { name: partner.brandName, supportEmail: partner.supportEmail, partnerId: partner.id }
    : DEFAULT_BRAND;
}

/** The brand a given USER lives under — for surfaces we show before any
 *  property is in play (admin chrome, the sign-in email). Unknown emails get
 *  the default, which is exactly right for open self-signup. */
export async function brandForUser(email: string): Promise<Brand> {
  const user = await getUser(email);
  return brandOf(await getPartner(user?.partnerId));
}

// ===== partner admin hosts =====
//
// hostname → partner id, one key per hostname exactly like the property domain
// index (domains.server.ts) and for the same reason: per-key writes can't drop
// a concurrent claim. `partner.adminHost` is the source of truth; the index is
// maintained on save and released on change.

const ADMIN_HOST_PREFIX = "partner-admin-host:";
const GUEST_HOST_PREFIX = "partner-guest-host:";
const adminHostKey = (host: string) => `${ADMIN_HOST_PREFIX}${host}`;
const guestHostKey = (host: string) => `${GUEST_HOST_PREFIX}${host}`;

async function hostIndexLookup(prefix: string, hostname: string): Promise<string | null> {
  const host = normalizeDomain(hostname);
  if (!host || isOwnHost(host)) return null;
  const kv = getConfigKV();
  if (!kv) return null;
  return (await kv.get(`${prefix}${host}`)) || null;
}

/** The partner whose ADMIN is served on `hostname`, or null. Request-path
 *  lookup: a single KV read. */
export const partnerIdForAdminHost = (hostname: string) => hostIndexLookup(ADMIN_HOST_PREFIX, hostname);

/** The partner whose GUEST booking domain `hostname` is, or null. */
export const partnerIdForGuestHost = (hostname: string) => hostIndexLookup(GUEST_HOST_PREFIX, hostname);

export type HostClaim = { ok: true } | { ok: false; error: string };

/** Bind a partner-host index key, refusing anything already spoken for: our
 *  own hosts, a hotel's live or reserved website domain, the partner-host
 *  namespace it isn't (one hostname can't be both admin and guest), or another
 *  partner. Same read-write-reread shape as domains.server claimKey — KV has
 *  no compare-and-swap, so success is only reported if our write stuck. */
async function claimPartnerHost(
  partnerId: string,
  hostname: string,
  key: (host: string) => string,
  otherKey: (host: string) => string,
): Promise<HostClaim> {
  const host = normalizeDomain(hostname);
  if (!host) return { ok: false, error: "Enter a hostname like admin.theirpms.com." };
  if (isOwnHost(host)) return { ok: false, error: "That hostname is one of ours." };
  const [liveProperty, reservedProperty] = await Promise.all([
    propertyIdForHost(host),
    domainSetupOwner(host),
  ]);
  if (liveProperty || reservedProperty) {
    return { ok: false, error: "A property's website already uses that hostname." };
  }
  const kv = getConfigKV();
  if (!kv) return { ok: true };
  if (await kv.get(otherKey(host))) {
    return { ok: false, error: "That hostname is already a partner host of the other kind." };
  }
  const owner = await kv.get(key(host));
  if (owner && owner !== partnerId) return { ok: false, error: "Another partner already uses that hostname." };
  await kv.put(key(host), partnerId);
  const settled = await kv.get(key(host));
  if (settled !== partnerId) return { ok: false, error: "Another partner already uses that hostname." };
  return { ok: true };
}

export const claimPartnerAdminHost = (partnerId: string, hostname: string) =>
  claimPartnerHost(partnerId, hostname, adminHostKey, guestHostKey);
export const claimPartnerGuestHost = (partnerId: string, hostname: string) =>
  claimPartnerHost(partnerId, hostname, guestHostKey, adminHostKey);

/** Drop `partnerId`'s claim on `host` (scoped to the owner, like releaseDomain:
 *  a stale stored value must not tear down another partner's live host). */
async function releasePartnerHost(partnerId: string, hostname: string | undefined, key: (h: string) => string) {
  const host = normalizeDomain(hostname ?? "");
  const kv = getConfigKV();
  if (!host || !kv) return;
  if ((await kv.get(key(host))) === partnerId) await kv.delete(key(host));
}
export const releasePartnerAdminHost = (partnerId: string, hostname: string | undefined) =>
  releasePartnerHost(partnerId, hostname, adminHostKey);
export const releasePartnerGuestHost = (partnerId: string, hostname: string | undefined) =>
  releasePartnerHost(partnerId, hostname, guestHostKey);
