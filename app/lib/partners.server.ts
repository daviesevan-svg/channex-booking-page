// White-label partners: a PMS reselling the booking engine under its own brand
// (docs/whitelabel.md). A partner is CONFIGURATION over the existing data —
// properties and users gain an optional partnerId; rooms/rates/ARI/bookings
// stay keyed by property id and never learn the word.
//
// Stored one key per partner (`partner:{id}`), like users: KV is eventually
// consistent and concurrent writes to one key overwrite each other, so a shared
// list would drop a partner when two saves race. Per-key writes can't collide.
import { getConfigKV } from "./config.server";
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
