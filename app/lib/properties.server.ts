// Property registry for the multi-property admin. The data layer is already
// keyed by property id (catalog_rooms:{id}, settings:{id}, …); this tracks which
// ids exist, who owns / is on the team for each, and which one the admin is
// currently editing (stored in the signed admin session). Access scoping for
// every admin route flows through getVisibleProperties()/currentPropertyId().
import { getAdminEmail, getSessionProperty } from "./auth.server";
import { getConfig, getConfigKV } from "./config.server";
import { getOverrides } from "./overrides.server";
import { isSuperadmin } from "./users.server";

export interface PropertyRef {
  id: string;
  name: string;
  /** Human-readable URL alias, e.g. book.roompanda.com/spilmanhotel instead of
   *  the UUID. ONLY a URL alias — the internal id (KV/D1/Stripe/ARI keys) stays
   *  the UUID; guest routes map an incoming id-or-slug via resolvePropertyId().
   *  Globally unique, lowercased. */
  slug?: string;
  /** Listed on the public root picker. Opt-in so staging/test properties stay
   *  off the public page; the seeded default property is public. */
  public?: boolean;
  /** Email of the user who owns (can see/edit) this property. Ownerless =
   *  legacy/unclaimed → visible to superadmins only. */
  owner?: string;
  /** Teammate emails the owner has invited to co-manage this property. They get
   *  full edit access to it, but can't manage the team, delete, or transfer it. */
  members?: string[];
}

const KEY = "properties";

async function read(): Promise<PropertyRef[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as PropertyRef[]) : [];
  } catch {
    return [];
  }
}

async function write(list: PropertyRef[]): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(KEY, JSON.stringify(list));
}

/** All registered properties. Auto-seeds the DEFAULT_PROPERTY_ID on first run so
 *  the existing single-property data shows up without a migration step. */
export async function getProperties(): Promise<PropertyRef[]> {
  const list = await read();
  if (list.length > 0) return list;
  const def = getConfig().defaultPropertyId;
  if (!def) return [];
  const ov = await getOverrides(def);
  const seeded: PropertyRef[] = [{ id: def, name: ov.hotelName || "Property 1", public: true }];
  await write(seeded);
  return seeded;
}

/** Properties shown on the public root picker (opt-in via the `public` flag). */
export async function getPublicProperties(): Promise<PropertyRef[]> {
  return (await getProperties()).filter((p) => p.public);
}

export async function addProperty(
  id: string,
  name: string,
  owner?: string,
): Promise<PropertyRef> {
  const list = await getProperties();
  const ref: PropertyRef = { id, name: name.trim() || "Untitled property", owner };
  if (!list.some((p) => p.id === id)) {
    list.push(ref);
    await write(list);
  }
  return ref;
}

/** Assigns (or clears) the owner of a property. Superadmin-only at the route. */
export async function setPropertyOwner(id: string, owner: string | undefined): Promise<void> {
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (p) {
    p.owner = owner;
    await write(list);
  }
}

/** Properties the signed-in user may see/edit: superadmins see all; everyone
 *  else sees the ones they own OR are a teammate on. This is the isolation
 *  chokepoint — every admin route resolves its active property through
 *  currentPropertyId(), which is scoped to this list. */
export async function getVisibleProperties(request: Request): Promise<PropertyRef[]> {
  const email = await getAdminEmail(request);
  if (!email) return [];
  const list = await getProperties();
  if (await isSuperadmin(email)) return list;
  return list.filter((p) => p.owner === email || p.members?.includes(email));
}

/** Whether the signed-in user may see/edit a property (owner, teammate, or superadmin). */
export async function canAccess(request: Request, id: string): Promise<boolean> {
  return (await getVisibleProperties(request)).some((p) => p.id === id);
}

/** A single property by id (unscoped). */
export async function getProperty(id: string): Promise<PropertyRef | undefined> {
  return (await getProperties()).find((p) => p.id === id);
}

// ── Slug (shortcode) URL aliases ──────────────────────────────────────────────
// A slug lets a hotel share book.roompanda.com/spilmanhotel instead of the UUID.
// It is purely a URL alias: guest routes call resolvePropertyId() to map the
// incoming :channelId (id OR slug) to the real id, which every data layer
// (KV/D1/Stripe/ARI) keeps using. Links keep the original segment, so the pretty
// URL persists through the whole booking flow.

/** Path segments claimed by other top-level routes — a slug must not collide
 *  with them (they'd shadow the guest route). Keep in sync with routes.ts. */
export const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "v1",
  "images",
  "feeds",
  "embed",
  "assets",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  ".well-known",
]);

/** 3–50 chars: lowercase letters/digits/hyphens, no leading or trailing hyphen. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

/** Validates a desired `slug` for property `id` against `list` (the current
 *  registry). Returns a human-readable error, or null if the slug is usable. */
export function slugError(slug: string, id: string, list: PropertyRef[]): string | null {
  if (!SLUG_RE.test(slug)) {
    return "Use 3–50 lowercase letters, numbers or hyphens — no spaces, and no leading or trailing hyphen.";
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved — pick another.`;
  // id match wins in resolvePropertyId, so a slug equal to another property's id
  // could never route here — block it to keep links unambiguous.
  if (list.some((p) => p.id !== id && p.id === slug)) return `"${slug}" is already in use.`;
  if (list.some((p) => p.id !== id && p.slug === slug)) {
    return `"${slug}" is already taken by another property.`;
  }
  return null;
}

/** A property by its slug (unscoped). */
export async function getPropertyBySlug(slug: string): Promise<PropertyRef | undefined> {
  const s = normalizeSlug(slug);
  if (!s) return undefined;
  return (await getProperties()).find((p) => p.slug === s);
}

/** Maps an incoming URL segment (a property id OR a slug) to the real property
 *  id. Exact id match wins (UUID URLs keep working and skip the slug lookup);
 *  otherwise a slug match; otherwise the input is returned unchanged, so unknown
 *  ids behave exactly as they did before slugs existed (render defaults). */
export async function resolvePropertyId(channelId: string): Promise<string> {
  if (!channelId) return channelId;
  const list = await getProperties();
  if (list.some((p) => p.id === channelId)) return channelId;
  const bySlug = list.find((p) => p.slug === channelId.toLowerCase());
  return bySlug ? bySlug.id : channelId;
}

/** Sets (or, with an empty string, clears) a property's slug. Validates format
 *  and global uniqueness. Returns {ok} or {error}. */
export async function setPropertySlug(
  id: string,
  slug: string,
): Promise<{ ok: true } | { error: string }> {
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (!p) return { error: "Property not found." };
  const s = normalizeSlug(slug);
  if (!s) {
    if (p.slug !== undefined) {
      delete p.slug;
      await write(list);
    }
    return { ok: true };
  }
  if (s === p.slug) return { ok: true };
  const err = slugError(s, id, list);
  if (err) return { error: err };
  p.slug = s;
  await write(list);
  return { ok: true };
}

/** Whether the user may MANAGE a property — manage its team, rename, toggle
 *  public, delete, transfer. Owner or superadmin only (teammates can edit
 *  content but not destroy/transfer/re-team the property). */
export async function isOwnerOrSuper(request: Request, id: string): Promise<boolean> {
  const email = await getAdminEmail(request);
  if (!email) return false;
  if (await isSuperadmin(email)) return true;
  return (await getProperty(id))?.owner === email;
}

/** Adds a teammate email to a property's team (dedup, lowercase; skips the owner). */
export async function addPropertyMember(id: string, email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!e) return;
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (!p || p.owner === e) return;
  const members = new Set(p.members ?? []);
  members.add(e);
  p.members = [...members];
  await write(list);
}

/** Removes a teammate from a property's team. */
export async function removePropertyMember(id: string, email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (!p?.members) return;
  p.members = p.members.filter((m) => m !== e);
  await write(list);
}

export async function renameProperty(id: string, name: string): Promise<void> {
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (p && name.trim()) {
    p.name = name.trim();
    await write(list);
  }
}

/** Toggles whether a property is listed on the public root picker. */
export async function setPropertyPublic(id: string, isPublic: boolean): Promise<void> {
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (p) {
    p.public = isPublic;
    await write(list);
  }
}

/** Removes a property from the registry. Its KV/D1 data is left intact (so a
 *  mistaken removal can be undone by re-adding the same id). */
export async function removeProperty(id: string): Promise<void> {
  await write((await getProperties()).filter((p) => p.id !== id));
}

/** The property the admin is currently editing: the session selection if it's
 *  one they can access, else the first property visible to them. Returns
 *  undefined when the user owns no properties (new self-signup). Scoping here
 *  isolates every admin route that resolves its property through this. */
export async function currentPropertyId(request: Request): Promise<string | undefined> {
  const list = await getVisibleProperties(request);
  const selected = await getSessionProperty(request);
  if (selected && list.some((p) => p.id === selected)) return selected;
  return list[0]?.id;
}
