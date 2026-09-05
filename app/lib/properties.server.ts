// Property registry for the multi-property admin. The data layer is already
// keyed by property id (catalog_rooms:{id}, settings:{id}, …); this tracks which
// ids exist, who owns / is on the team for each, and which one the admin is
// currently editing (stored in the signed admin session). Access scoping for
// every admin route flows through getVisibleProperties()/currentPropertyId().
import { getAdminEmail, getSessionProperty } from "./auth.server";
import { getConfig, getConfigKV } from "./config.server";
import { db, schemaOnce } from "./d1.server";
import { requestKvCache } from "./request-cache.server";
import { getOverrides, getSettings } from "./overrides.server";
import { getUser, isSuperadmin } from "./users.server";
import { areaForPathname, type MemberArea } from "./member-areas";
import { releaseDomain } from "./domains.server";
import { deleteCustomHostname } from "./custom-hostnames.server";
import {
  canManageProperty as actorCanManageProperty,
  canOwnProperty,
  type AccessActor,
} from "./property-access";

export { canOwnProperty, canManageProperty as actorCanManageProperty } from "./property-access";
export type { AccessActor, AccessProperty } from "./property-access";

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
  /** Page areas (member-areas.ts) HIDDEN from a teammate, keyed by email —
   *  absent/empty = full access, mirroring the partner hiddenPages semantics.
   *  Set from the Team page; enforced by assertMemberAreaAllowed below. */
  memberHiddenAreas?: Record<string, MemberArea[]>;
  /** Discoverable in the directory collection operators browse. Opt-OUT — unset
   *  means listed. Only content already public on the property's own booking
   *  page is exposed there, and never a contact address, so the directory can't
   *  be harvested as a lead list. */
  directoryListed?: boolean;
  /** White-label partner (PMS) this property belongs to (docs/whitelabel.md).
   *  Unset = a direct Roompanda property. Partner properties are scoped to the
   *  partner's admins and kept off our public surfaces. */
  partnerId?: string;
}

// ---- storage ----
//
// One ROW per property, not one KV key for all of them.
//
// The registry used to live in a single KV value that every tenant rewrote:
// read the whole list, change one entry, put the whole list back. Two writes
// overlapping meant the later one silently reverted the earlier — and the
// writes here are `removePropertyMember`, `setPropertyOwner`, member area
// grants. A lost update there is not a cosmetic glitch: it hands someone back
// access that was just taken away, with no error anywhere and nothing in the
// UI to suggest the change did not stick.
//
// KV has no compare-and-swap, so the fix is to stop writing the set. Each
// property is its own D1 row and each mutation is an UPDATE of that row, so
// two properties can never overwrite each other and two edits to the SAME
// property serialise in the database.
//
// The list is still read whole — `resolvePropertyId` maps a slug on every
// guest request — which is why this is a table and not per-property KV keys:
// one SELECT, not one GET per property.
//
// The legacy KV key stays, written after every change as a derived snapshot.
// It is never the source of truth; it exists so a rollback to the previous
// code finds current data, and so a D1 outage degrades to a possibly-stale
// registry instead of no registry at all.
const KEY = "properties";

const ensureSchema = schemaOnce((d) => [
  d.prepare(`CREATE TABLE IF NOT EXISTS property (id TEXT PRIMARY KEY, json TEXT NOT NULL)`),
]);

// An indexed, always-correct projection of the slug out of `json`.
//
// `resolvePropertyId` runs in the layout loader of every guest request and used
// to answer by reading and parsing the WHOLE registry, so each hotel's page
// paid for every other hotel that exists. A GENERATED column is the version of
// this with no way to drift: SQLite derives it from `json` on read, so nothing
// on the write path has to remember to keep it in step and there is no backfill
// for rows written before it existed.
//
// It lives outside ensureSchema because ALTER TABLE has no IF NOT EXISTS, and a
// statement that throws inside a batch takes the CREATE TABLE with it. Every
// isolate after the first finds the column already there, which is the
// "duplicate column" case swallowed below.
let slugIndexReady: Promise<void> | undefined;

function ensureSlugIndex(): Promise<void> {
  slugIndexReady ??= (async () => {
    await ensureSchema();
    try {
      await db()
        .prepare(
          `ALTER TABLE property ADD COLUMN slug TEXT GENERATED ALWAYS AS (lower(json_extract(json,'$.slug'))) VIRTUAL`,
        )
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column/i.test(message)) throw error;
    }
    await db().prepare(`CREATE INDEX IF NOT EXISTS property_slug ON property (slug)`).run();
  })().catch((error) => {
    // Let the next caller retry rather than latching the failure for the life
    // of the isolate. Lookups fall back to the full read meanwhile.
    slugIndexReady = undefined;
    throw error;
  });
  return slugIndexReady;
}

/** One property by id and/or slug, in a single round trip of indexed lookups.
 *
 *  `total` comes back with it so a miss can tell "no such property" — the
 *  answer — from "the registry has no rows yet", which is the seed-on-first-run
 *  and migrate-from-KV path and has to go through the full read. Null means D1
 *  itself was unreachable: same, the full read owns the snapshot fallback. */
async function lookupOne(id: string, slug: string): Promise<{ total: number; byId?: PropertyRef; bySlug?: PropertyRef } | null> {
  const cacheKey = `${POINT_CACHE_PREFIX}${id}\u0000${slug}`;
  const cache = requestKvCache();
  // The whole registry may already be in hand (an admin list, the picker). It
  // is the same data and already paid for, so don't ask the database again.
  const whole = cache?.get(READ_CACHE_KEY);
  if (whole) {
    const list = JSON.parse((await whole) ?? "[]") as PropertyRef[];
    return { total: list.length, byId: list.find((p) => p.id === id), bySlug: list.find((p) => p.slug === slug) };
  }

  const run = async (): Promise<string> => {
    await ensureSlugIndex();
    const row = await db()
      .prepare(
        `SELECT (SELECT COUNT(*) FROM property) AS total,
                (SELECT json FROM property WHERE id = ?1) AS by_id,
                (SELECT json FROM property WHERE slug = ?2) AS by_slug`,
      )
      .bind(id, slug)
      .first<{ total: number; by_id: string | null; by_slug: string | null }>();
    return JSON.stringify(row ?? { total: 0, by_id: null, by_slug: null });
  };

  try {
    const hit = cache?.get(cacheKey);
    let raw: string;
    if (hit) {
      raw = (await hit) ?? "";
    } else {
      const pending = run();
      cache?.set(cacheKey, pending);
      pending.catch(() => cache?.delete(cacheKey));
      raw = await pending;
    }
    const row = JSON.parse(raw) as { total: number; by_id: string | null; by_slug: string | null };
    return { total: row.total, byId: parseRef(row.by_id), bySlug: parseRef(row.by_slug) };
  } catch {
    return null;
  }
}

function parseRef(json: string | null): PropertyRef | undefined {
  if (!json) return undefined;
  try {
    const ref = JSON.parse(json) as PropertyRef;
    return typeof ref?.id === "string" ? ref : undefined;
  } catch {
    return undefined;
  }
}

/** The KV snapshot: the fallback, and what a rollback would read. */
async function readSnapshot(): Promise<PropertyRef[]> {
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

/** Refresh the snapshot from the rows. Derived, so a lost write costs nothing
 *  but freshness — never data. Failures are swallowed on purpose: the write
 *  that matters already committed. */
async function writeSnapshot(list: PropertyRef[]): Promise<void> {
  try {
    const kv = getConfigKV();
    if (kv) await kv.put(KEY, JSON.stringify(list));
  } catch {
    /* derived data; the rows are the truth */
  }
}

/** Move the old single-key registry into rows, once. INSERT OR IGNORE so two
 *  isolates racing the migration cannot duplicate or clobber. */
async function migrateFromSnapshot(): Promise<PropertyRef[]> {
  const legacy = await readSnapshot();
  if (legacy.length === 0) return [];
  await db().batch(
    legacy.map((p) =>
      db().prepare(`INSERT OR IGNORE INTO property (id, json) VALUES (?, ?)`).bind(p.id, JSON.stringify(p)),
    ),
  );
  return legacy;
}

// One SELECT per request, not per call. `resolvePropertyId` runs in the layout
// loader on every guest page and the auth chain reads the registry again, so
// without this the move from KV to D1 would trade one cached KV get for
// several database round trips on the hot path — undoing the work that got a
// funnel step down to six reads. Same scope and same invalidate-on-write rule
// as the KV cache it borrows (request-cache.server.ts).
const READ_CACHE_KEY = "d1:property-registry";

/** Point lookups are cached under this prefix, one entry per (id, slug) pair. */
const POINT_CACHE_PREFIX = "d1:property:";

function dropReadCache(): void {
  const cache = requestKvCache();
  if (!cache) return;
  cache.delete(READ_CACHE_KEY);
  // The point lookups are the same data under different keys — a write that
  // left them behind would serve the pre-write row for the rest of the request.
  for (const key of [...cache.keys()]) if (key.startsWith(POINT_CACHE_PREFIX)) cache.delete(key);
}

async function read(): Promise<PropertyRef[]> {
  const cache = requestKvCache();
  if (!cache) return loadRows();
  const hit = cache.get(READ_CACHE_KEY);
  if (hit) return JSON.parse((await hit) ?? "[]") as PropertyRef[];
  const pending = loadRows().then((rows) => JSON.stringify(rows));
  cache.set(READ_CACHE_KEY, pending);
  return JSON.parse(await pending) as PropertyRef[];
}

async function loadRows(): Promise<PropertyRef[]> {
  try {
    await ensureSchema();
    const { results } = await db().prepare(`SELECT json FROM property`).all<{ json: string }>();
    const rows = (results ?? [])
      .map((r) => {
        try {
          return JSON.parse(r.json) as PropertyRef;
        } catch {
          return null;
        }
      })
      .filter((p): p is PropertyRef => !!p && typeof p.id === "string");
    if (rows.length > 0) return rows;
    return await migrateFromSnapshot();
  } catch {
    // D1 unreachable. The snapshot is stale at worst; an empty registry would
    // 404 every guest page and lock every operator out of the admin.
    return readSnapshot();
  }
}

/** Insert or update ONE property. The whole point of this module's storage:
 *  nothing here can touch another property's row. */
async function putRow(ref: PropertyRef): Promise<void> {
  await ensureSchema();
  await db()
    .prepare(`INSERT INTO property (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`)
    .bind(ref.id, JSON.stringify(ref))
    .run();
  dropReadCache();
  await writeSnapshot(await read());
}

async function deleteRow(id: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`DELETE FROM property WHERE id=?`).bind(id).run();
  dropReadCache();
  await writeSnapshot(await read());
}

/** Persist one entry of a list the caller has already mutated in place. The
 *  shape every mutation below had before rows existed — kept so each one reads
 *  the same, minus the clobber. */
async function writeOne(list: PropertyRef[], id: string): Promise<void> {
  const ref = list.find((p) => p.id === id);
  if (ref) await putRow(ref);
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
  await putRow(seeded[0]);
  return seeded;
}

/** Properties shown on the public root picker (opt-in via the `public` flag).
 *  Partner properties never appear — a PMS's hotels must not be listed on OUR
 *  public front door (docs/whitelabel.md §10); their own picker comes with the
 *  partner guest host in the domains phase. */
export async function getPublicProperties(): Promise<PropertyRef[]> {
  return (await getProperties()).filter((p) => p.public && !p.partnerId);
}

/** Ids are opaque keys (UUIDs, a channel manager's hotel code): one segment of
 *  URL-safe characters. Anything else could not be routed or keyed safely. */
const PROPERTY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Why a proposed property id can't be registered, or null when it can.
 *
 * `resolvePropertyId` matches ids BEFORE slugs, so an id equal to another
 * property's slug would silently capture that property's guest URL — every
 * link the hotel has ever handed out would land on the newcomer. `slugError`
 * closes the mirror case (a slug equal to an existing id); this closes the one
 * that was open.
 */
export function propertyIdError(id: string, list: PropertyRef[]): string | null {
  if (!PROPERTY_ID_RE.test(id)) return "Property ids may only contain letters, digits, hyphens and underscores.";
  const lower = id.toLowerCase();
  if (RESERVED_SLUGS.has(lower)) return `"${id}" is reserved — pick another.`;
  if (list.some((p) => p.id === id)) return `A property with the id "${id}" already exists.`;
  if (list.some((p) => p.slug === lower)) return `"${id}" is already in use as another property's booking link.`;
  return null;
}

/** A removed property's grave marker. Re-registering that id would revive every
 *  KV/D1 record it left behind, so only its previous owner may (see addProperty). */
interface PropertyTombstone {
  owner?: string;
  deletedAt: string;
}
const tombstoneKey = (id: string) => `property_tombstone:${id}`;

async function readTombstone(id: string): Promise<PropertyTombstone | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(tombstoneKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PropertyTombstone;
  } catch {
    return null;
  }
}

/**
 * Registers a property. Throws (with a message fit to show the operator) when
 * the id can't be used: malformed, reserved, colliding with another property's
 * id or slug, or the id of a DELETED property that belonged to someone else.
 *
 * That last rule is what makes deletion safe. The data layer is keyed by id and
 * a removal leaves content behind on purpose (a mistaken delete is undone by
 * re-adding), so without it anyone who learned a deleted property's id — they
 * are public, in guest URLs and webhook addresses — could re-add it and inherit
 * its bookings and whatever settings survived. `reclaim` (superadmin) overrides.
 */
export async function addProperty(
  id: string,
  name: string,
  owner?: string,
  partnerId?: string,
  opts: { reclaim?: boolean } = {},
): Promise<PropertyRef> {
  const list = await getProperties();
  const existing = list.find((p) => p.id === id);
  if (existing) {
    // Re-adding your own property is a no-op (the Channex import re-runs this
    // for an already-imported hotel); anyone else is refused — before this, a
    // stranger holding the hotel's channel-manager key could "import" it again
    // and overwrite its rooms, rates and settings from here on.
    const same = !!existing.owner && existing.owner.toLowerCase() === (owner ?? "").toLowerCase();
    if (same || opts.reclaim) return existing;
    throw new Error(`A property with the id "${id}" already exists and belongs to another account.`);
  }
  const problem = propertyIdError(id, list);
  if (problem) throw new Error(problem);
  if (!opts.reclaim) {
    const grave = await readTombstone(id);
    if (grave && grave.owner !== (owner ?? "").toLowerCase()) {
      throw new Error(`"${id}" belonged to a property that was deleted by another account and can't be reused.`);
    }
  }
  const ref: PropertyRef = { id, name: name.trim() || "Untitled property", owner, ...(partnerId ? { partnerId } : {}) };
  list.push(ref);
  await putRow(ref);
  return ref;
}

/** Assigns (or clears) a property's partner. Superadmin-only at the route. */
export async function setPropertyPartner(id: string, partnerId: string | undefined): Promise<void> {
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (p) {
    if (partnerId) p.partnerId = partnerId;
    else delete p.partnerId;
    await writeOne(list, id);
  }
}

/** Assigns (or clears) the owner of a property. Superadmin-only at the route. */
export async function setPropertyOwner(id: string, owner: string | undefined): Promise<void> {
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (p) {
    p.owner = owner;
    await writeOne(list, id);
  }
}

/** Properties the signed-in user may see/edit: superadmins see all; a
 *  partner_admin sees every property of their partner; everyone else sees the
 *  ones they own OR are a teammate on. This is the isolation chokepoint —
 *  every admin route resolves its active property through currentPropertyId(),
 *  which is scoped to this list. */
export async function getVisibleProperties(request: Request): Promise<PropertyRef[]> {
  const email = await getAdminEmail(request);
  if (!email) return [];
  const list = await getProperties();
  if (await isSuperadmin(email)) return list;
  const user = await getUser(email);
  if (user?.role === "partner_admin" && user.partnerId) {
    const pid = user.partnerId;
    return list.filter((p) => p.partnerId === pid || p.owner === email || p.members?.includes(email));
  }
  return list.filter((p) => p.owner === email || p.members?.includes(email));
}

/** Whether the signed-in user may see/edit a property (owner, teammate, or superadmin). */
export async function canAccess(request: Request, id: string): Promise<boolean> {
  return (await getVisibleProperties(request)).some((p) => p.id === id);
}

/** A single property by id (unscoped). */
export async function getProperty(id: string): Promise<PropertyRef | undefined> {
  // One indexed row, not the whole registry parsed to find it. The full read
  // still owns the empty-registry cases (seed the default property, migrate the
  // legacy KV snapshot) and the D1-outage fallback, so a miss defers to it only
  // when there is genuinely nothing to have missed.
  const hit = await lookupOne(id, "");
  if (hit && (hit.byId || hit.total > 0)) return hit.byId;
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
  "c", // collection landing pages live at /c/:collectionSlug
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

/** True when `s` is a valid slug FORMAT (shared with collection slugs). */
export function isValidSlugFormat(s: string): boolean {
  return SLUG_RE.test(s);
}

/** Slugify free text into a candidate slug (letters/digits/hyphens). May be
 *  empty or too short — callers validate/uniquify. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
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

/** Maps an incoming URL segment (a property id OR a slug) to the real property
 *  id. Exact id match wins (UUID URLs keep working and skip the slug lookup);
 *  otherwise a slug match; otherwise the input is returned unchanged, so unknown
 *  ids behave exactly as they did before slugs existed (render defaults). */
export async function resolvePropertyId(channelId: string): Promise<string> {
  if (!channelId) return channelId;
  // The hottest read in the app: every guest request's layout loader lands
  // here. Both halves are one indexed round trip — id first, so a UUID URL
  // still wins outright and a slug can never capture it.
  const hit = await lookupOne(channelId, channelId.toLowerCase());
  if (hit && (hit.byId || hit.bySlug || hit.total > 0)) {
    if (hit.byId) return channelId;
    return hit.bySlug ? hit.bySlug.id : channelId;
  }
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
      await writeOne(list, id);
    }
    return { ok: true };
  }
  if (s === p.slug) return { ok: true };
  const err = slugError(s, id, list);
  if (err) return { error: err };
  p.slug = s;
  await writeOne(list, id);
  return { ok: true };
}

/** Signed-in actor for the pure access helpers. Null when there is no session. */
export async function accessActor(request: Request): Promise<AccessActor | null> {
  const email = await getAdminEmail(request);
  if (!email) return null;
  const [superadmin, user] = await Promise.all([isSuperadmin(email), getUser(email)]);
  return { email, role: user?.role, partnerId: user?.partnerId, superadmin };
}

/** Whether the user may OWN a property — money, listing, slug, live booking.
 *  Owner email or superadmin only. partner_admin is not included unless they
 *  personally own the hotel. */
export async function isOwnerOrSuper(request: Request, id: string): Promise<boolean> {
  const actor = await accessActor(request);
  if (!actor) return false;
  return canOwnProperty(actor, await getProperty(id));
}

/** Whether the user may operate owner-class ops on a hotel they do not
 *  personally own: team, API keys, webhooks, refunds, Google save, widget
 *  theme. Owner, partner_admin of that hotel's partner, or superadmin. */
export async function canManageProperty(request: Request, id: string): Promise<boolean> {
  const actor = await accessActor(request);
  if (!actor) return false;
  return actorCanManageProperty(actor, await getProperty(id));
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
  await writeOne(list, id);
}

/** Removes a teammate from a property's team. */
export async function removePropertyMember(id: string, email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (!p?.members) return;
  p.members = p.members.filter((m) => m !== e);
  // Their access entry goes with them — a later re-invite starts clean.
  if (p.memberHiddenAreas && e in p.memberHiddenAreas) {
    delete p.memberHiddenAreas[e];
    if (!Object.keys(p.memberHiddenAreas).length) delete p.memberHiddenAreas;
  }
  await writeOne(list, id);
}

export async function renameProperty(id: string, name: string): Promise<void> {
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (p && name.trim()) {
    p.name = name.trim();
    await writeOne(list, id);
  }
}

/** Toggles whether a property is listed on the public root picker. */
export async function setPropertyPublic(id: string, isPublic: boolean): Promise<void> {
  const list = await getProperties();
  const p = list.find((x) => x.id === id);
  if (p) {
    p.public = isPublic;
    await writeOne(list, id);
  }
}

/** Removes a property from the registry and leaves a tombstone naming its owner.
 *  Its content (rooms, texts, bookings) stays in KV/D1 so a mistaken removal can
 *  be undone by the same owner re-adding the id; credentials do NOT stay — see
 *  `deletePropertyForGood` in property-delete.server.ts, the entry point routes
 *  use, which revokes keys/webhooks/payment config before calling this. */
export async function removeProperty(id: string): Promise<void> {
  // Release the custom hostname before dropping the registry row. The hostname
  // index is global, so a leftover entry would both keep the domain
  // unclaimable by anyone else and point guests at a property that now 404s.
  const domain = (await getSettings(id)).websiteDomain;
  const released = await releaseDomain(id, domain).catch(() => false);
  // Deregister at the edge too, but only on the index's word that the hostname
  // was ours: a stored domain can name one this property never held, and deleting
  // on that basis would take the real holder's site down.
  if (released && domain) await deleteCustomHostname(domain).catch(() => {});
  const list = await getProperties();
  const ref = list.find((p) => p.id === id);
  const kv = getConfigKV();
  if (kv) {
    const grave: PropertyTombstone = { owner: ref?.owner?.toLowerCase(), deletedAt: new Date().toISOString() };
    await kv.put(tombstoneKey(id), JSON.stringify(grave));
  }
  await deleteRow(id);
}

/** The property the admin is currently editing: the session selection if it's
 *  one they can access, else the first property visible to them. Returns
 *  undefined when the user owns no properties (new self-signup). Scoping here
 *  isolates every admin route that resolves its property through this. */
export async function currentPropertyId(request: Request): Promise<string | undefined> {
  const list = await getVisibleProperties(request);
  const selected = await getSessionProperty(request);
  const id = selected && list.some((p) => p.id === selected) ? selected : list[0]?.id;
  const property = id ? list.find((p) => p.id === id) : undefined;
  if (property) await assertMemberAreaAllowed(request, property);
  return id;
}

/** Whether per-member area restrictions bind this user on this property.
 *  Never the owner (the Team UI doesn't offer it, and a stale entry must not
 *  lock an owner out), superadmins, or the property's own partner admins. */
async function memberRestrictionApplies(p: PropertyRef, email: string): Promise<boolean> {
  if (p.owner === email) return false;
  if (await isSuperadmin(email)) return false;
  const user = await getUser(email);
  if (user?.role === "partner_admin" && user.partnerId && user.partnerId === p.partnerId) return false;
  return true;
}

/** 404s when a teammate opens a page in an area the owner hid from them (the
 *  Team page checkboxes). Enforced HERE, on the property resolver every
 *  property-scoped loader and action already flows through, so a new admin
 *  route is covered without anyone remembering a guard — nav-hiding alone
 *  would repeat the wildcard-route mistake. Cheap checks (URL, in-memory map)
 *  run before any extra KV reads; 404 rather than redirect because to this
 *  member the page does not exist. */
async function assertMemberAreaAllowed(request: Request, p: PropertyRef): Promise<void> {
  const area = areaForPathname(new URL(request.url).pathname);
  if (!area) return;
  const email = await getAdminEmail(request);
  if (!email) return;
  if (!p.memberHiddenAreas?.[email]?.includes(area)) return;
  if (!(await memberRestrictionApplies(p, email))) return;
  throw new Response("Not found", { status: 404 });
}

/** The areas hidden from this user on this property — nav-side companion of
 *  assertMemberAreaAllowed (same exemptions), used by the layout to drop nav
 *  items. Empty for everyone the restriction doesn't bind. */
export async function hiddenMemberAreasFor(request: Request, propertyId: string | undefined): Promise<MemberArea[]> {
  if (!propertyId) return [];
  const email = await getAdminEmail(request);
  if (!email) return [];
  const p = await getProperty(propertyId);
  const hidden = p?.memberHiddenAreas?.[email];
  if (!p || !hidden?.length) return [];
  return (await memberRestrictionApplies(p, email)) ? hidden : [];
}

/** Replaces a teammate's hidden-area list (empty = full access, entry removed).
 *  Owner-or-superadmin gating happens at the route; unknown emails are ignored
 *  so a removed member can't be re-added through this side door. */
export async function setMemberHiddenAreas(id: string, email: string, hidden: MemberArea[]): Promise<void> {
  const e = email.trim().toLowerCase();
  const list = await read();
  const p = list.find((x) => x.id === id);
  if (!p || !p.members?.includes(e)) return;
  const map = { ...(p.memberHiddenAreas ?? {}) };
  if (hidden.length) map[e] = hidden;
  else delete map[e];
  if (Object.keys(map).length) p.memberHiddenAreas = map;
  else delete p.memberHiddenAreas;
  await writeOne(list, id);
}
