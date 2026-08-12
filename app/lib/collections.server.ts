// Collections: a curated group of properties presented on one branded landing
// page at /c/:slug. A collection is purely a presentation layer over existing
// properties: each member keeps its own data, calendar, rates and booking flow.
//
// STORAGE: one KV key PER collection (`collection:{slug}`), enumerated with a
// prefix list. The original design kept the whole list under a single key and
// read-modify-wrote it, which was fine while the only writer was the one owner
// editing their own collections. It stops being fine as soon as a property can
// accept an invitation while an operator adds someone else: two concurrent
// read-modify-writes to one key silently drop one of the changes. Per-key
// storage makes those writes independent.
//
// MEMBERSHIP is a small state machine rather than a list of ids, because a
// property can now be mid-invitation or mid-request. `propertyIds` survives as a
// DERIVED, read-only view of the active members in display order, so everything
// that renders a collection keeps working unchanged.
import { getAdminEmail } from "./auth.server";
import { getConfigKV } from "./config.server";
import type { SiteSettings } from "./content";
import {
  isValidSlugFormat,
  normalizeSlug,
  RESERVED_SLUGS,
  slugify,
} from "./properties.server";
import { isSuperadmin } from "./users.server";

/** Who may join a collection, and how.
 *
 *  - `private`  — the operator's own properties only. Not joinable, not
 *                 requestable, and not offered anywhere. This is what every
 *                 collection was before membership existed, so it is the
 *                 migration value for existing rows (NOT the default for new
 *                 ones — silently opening a hotel group's internal collection
 *                 to strangers would be a real breach of intent).
 *  - `official` — the operator invites; the property must accept. No requests.
 *  - `curated`  — the operator adds immediately and the property can remove
 *                 itself; requests to join need approval. Default for new.
 *  - `open`     — anyone may add themselves, no approval. */
export type MembershipMode = "private" | "official" | "curated" | "open";

/** `invited` and `requested` are the two waiting states, distinguished by who
 *  has to act next. Both converge on `active`, so the public page renders one
 *  thing regardless of how a member arrived. Terminal states are kept rather
 *  than deleted so repeat asks can be rate-limited. */
export type MemberStatus = "active" | "invited" | "requested" | "declined" | "left";

export interface CollectionMember {
  propertyId: string;
  status: MemberStatus;
  /** Which side started it. Reads back in the audit trail when the two parties
   *  disagree about what was agreed. */
  initiatedBy: "collection" | "property";
  createdAt: string;
  activatedAt?: string;
  endedAt?: string;
}

export interface Collection {
  slug: string;
  name: string;
  /** Destination label shown in the eyebrow, e.g. "Dublin". */
  destination?: string;
  /** Page headline (h1). Defaults to "Choose where you'll stay" when unset. */
  heading?: string;
  /** Intro paragraph under the title. */
  intro?: string;
  /** Contact phone shown in the header. */
  phone?: string;
  /** Shared theme for the landing (mirrors SiteSettings theming). */
  theme?: SiteSettings["theme"];
  customColor?: string;
  customBg?: string;
  themeFont?: string;
  /** Owning user's email (scoping). */
  owner?: string;
  /** Additional emails that may administer this collection. The owner is always
   *  an operator implicitly. Exists from the start so a collection can outlive
   *  being run by one property owner — a destination body administering hotels
   *  it doesn't own is the whole point of the non-private modes. */
  operators?: string[];
  membershipMode: MembershipMode;
  /** Listed in the directory properties browse when looking for a collection to
   *  join. Off for private (nothing to join); the public /c/ page is unaffected
   *  either way — a private group's landing page is still its shop window. */
  directoryListed?: boolean;
  members: CollectionMember[];
  /** DERIVED on read — active members in display order. Never persisted; write
   *  through `updateCollection({ propertyIds })`, which reconciles `members`. */
  propertyIds: string[];
}

/** Stored shape: everything except the derived view. */
type StoredCollection = Omit<Collection, "propertyIds"> & {
  /** Legacy field from before membership had states. Migrated on read. */
  propertyIds?: string[];
};

const PREFIX = "collection:";
const LEGACY_KEY = "collections";
/** Presence means the single-key blob has been split into per-collection keys.
 *  The blob itself is left in place as a manual backup rather than deleted. */
const MIGRATED_KEY = "collections:migrated";

const keyFor = (slug: string) => `${PREFIX}${slug}`;

/** Fills in the fields added after a collection was first written. Existing
 *  collections predate membership entirely, so they are `private`: their member
 *  list is exactly the owner's own properties, chosen by hand. */
function hydrate(stored: StoredCollection): Collection {
  const members: CollectionMember[] =
    stored.members ??
    (stored.propertyIds ?? []).map((propertyId) => ({
      propertyId,
      status: "active" as const,
      initiatedBy: "collection" as const,
      createdAt: new Date(0).toISOString(),
      activatedAt: new Date(0).toISOString(),
    }));
  return {
    ...stored,
    membershipMode: stored.membershipMode ?? "private",
    members,
    propertyIds: members.filter((m) => m.status === "active").map((m) => m.propertyId),
  };
}

function dehydrate(c: Collection): StoredCollection {
  const { propertyIds: _derived, ...rest } = c;
  return rest;
}

/** Set once the marker has been seen, so the steady state costs no extra KV
 *  read per call (mirrors the `schemaReady` pattern in the D1 modules). */
let migrationChecked = false;

/** Splits the legacy single-key list into per-collection keys, once. Idempotent:
 *  concurrent callers write identical values, and it only ever runs before any
 *  per-key writes exist, so there is nothing to clobber. */
async function migrateLegacy(kv: KVNamespace): Promise<void> {
  if (migrationChecked) return;
  if (await kv.get(MIGRATED_KEY)) {
    migrationChecked = true;
    return;
  }
  const raw = await kv.get(LEGACY_KEY);
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const c of arr as StoredCollection[]) {
          if (!c?.slug) continue;
          await kv.put(keyFor(c.slug), JSON.stringify(dehydrate(hydrate(c))));
        }
      }
    } catch {
      // A corrupt blob shouldn't wedge every read; the marker still goes down so
      // we don't retry the same parse on every request.
    }
  }
  await kv.put(MIGRATED_KEY, new Date().toISOString());
  migrationChecked = true;
}

async function readOne(slug: string): Promise<Collection | undefined> {
  const kv = getConfigKV();
  if (!kv) return undefined;
  await migrateLegacy(kv);
  const raw = await kv.get(keyFor(slug));
  if (!raw) return undefined;
  try {
    return hydrate(JSON.parse(raw) as StoredCollection);
  } catch {
    return undefined;
  }
}

async function readAll(): Promise<Collection[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  await migrateLegacy(kv);
  const out: Collection[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: PREFIX, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        out.push(hydrate(JSON.parse(raw) as StoredCollection));
      } catch {
        // Skip an unreadable entry rather than failing the whole listing.
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function writeOne(c: Collection): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(keyFor(c.slug), JSON.stringify(dehydrate(c)));
}

export async function getCollections(): Promise<Collection[]> {
  return readAll();
}

/** A single collection by slug (unscoped — public landing uses this). */
export async function getCollectionBySlug(slug: string): Promise<Collection | undefined> {
  const s = normalizeSlug(slug);
  if (!s) return undefined;
  return readOne(s);
}

/** Collections the signed-in user may see/edit: superadmins see all; everyone
 *  else sees the ones they own or operate. */
export async function getVisibleCollections(request: Request): Promise<Collection[]> {
  const email = await getAdminEmail(request);
  if (!email) return [];
  const list = await readAll();
  if (await isSuperadmin(email)) return list;
  return list.filter((c) => c.owner === email || c.operators?.includes(email));
}

export async function canAccessCollection(request: Request, slug: string): Promise<boolean> {
  return (await getVisibleCollections(request)).some((c) => c.slug === normalizeSlug(slug));
}

/** Validates a desired collection `slug` against `list` (excluding `currentSlug`
 *  when renaming). Collections live under /c/ so they don't clash with property
 *  slugs; they only need a valid format, a non-reserved value, and uniqueness
 *  among collections. Returns an error string, or null when usable. */
export function collectionSlugError(
  slug: string,
  currentSlug: string,
  list: Collection[],
): string | null {
  if (!isValidSlugFormat(slug)) {
    return "Use 3–50 lowercase letters, numbers or hyphens — no spaces, and no leading or trailing hyphen.";
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved — pick another.`;
  if (list.some((c) => c.slug !== currentSlug && c.slug === slug)) {
    return `"${slug}" is already taken by another collection.`;
  }
  return null;
}

/** Creates a collection owned by `owner`, deriving a unique slug from `name`. */
export async function createCollection(name: string, owner: string): Promise<Collection> {
  const list = await readAll();
  const clean = name.trim() || "New collection";
  // Derive a unique slug: base from the name, then -2, -3… until free.
  let base = slugify(clean);
  if (base.length < 3) base = `collection-${base}`.slice(0, 50);
  let slug = base;
  let n = 2;
  while (list.some((c) => c.slug === slug) || RESERVED_SLUGS.has(slug)) {
    slug = `${base}-${n++}`.slice(0, 50);
  }
  const col: Collection = {
    slug,
    name: clean,
    owner,
    membershipMode: "curated",
    directoryListed: true,
    members: [],
    propertyIds: [],
  };
  await writeOne(col);
  return col;
}

/** Reconciles the active membership against a chosen set of property ids,
 *  preserving the given order. Ids already active are reordered; new ones become
 *  active; ones dropped from the set are ended. Members in a waiting or terminal
 *  state are left alone — this is the "tick the boxes" editor, not the
 *  invitation flow. */
function reconcileMembers(members: CollectionMember[], ids: string[], now: string): CollectionMember[] {
  const wanted = new Set(ids);
  const byId = new Map(members.map((m) => [m.propertyId, m]));
  const next: CollectionMember[] = [];

  for (const propertyId of ids) {
    const existing = byId.get(propertyId);
    if (existing) {
      next.push({ ...existing, status: "active", activatedAt: existing.activatedAt ?? now, endedAt: undefined });
    } else {
      next.push({
        propertyId,
        status: "active",
        initiatedBy: "collection",
        createdAt: now,
        activatedAt: now,
      });
    }
  }
  for (const m of members) {
    if (wanted.has(m.propertyId)) continue;
    next.push(m.status === "active" ? { ...m, status: "left", endedAt: now } : m);
  }
  return next;
}

/** Merge-updates a collection's editable fields (never its owner). Slug changes
 *  are validated; an invalid slug is rejected (returns {error}) without saving. */
export async function updateCollection(
  slug: string,
  patch: Partial<Omit<Collection, "owner" | "members">>,
): Promise<{ ok: true; collection: Collection } | { error: string }> {
  const current = normalizeSlug(slug);
  const c = await readOne(current);
  if (!c) return { error: "Collection not found." };

  let renamedFrom: string | undefined;
  if (patch.slug !== undefined) {
    const s = normalizeSlug(patch.slug);
    const err = collectionSlugError(s, c.slug, await readAll());
    if (err) return { error: err };
    if (s !== c.slug) renamedFrom = c.slug;
    c.slug = s;
  }
  if (patch.name !== undefined) c.name = patch.name.trim() || c.name;
  if (patch.destination !== undefined) c.destination = patch.destination.trim() || undefined;
  if (patch.heading !== undefined) c.heading = patch.heading.trim() || undefined;
  if (patch.intro !== undefined) c.intro = patch.intro.trim() || undefined;
  if (patch.phone !== undefined) c.phone = patch.phone.trim() || undefined;
  if (patch.theme !== undefined) c.theme = patch.theme;
  if (patch.customColor !== undefined) c.customColor = patch.customColor || undefined;
  if (patch.customBg !== undefined) c.customBg = patch.customBg || undefined;
  if (patch.themeFont !== undefined) c.themeFont = patch.themeFont || undefined;
  if (patch.membershipMode !== undefined) c.membershipMode = patch.membershipMode;
  if (patch.directoryListed !== undefined) c.directoryListed = patch.directoryListed;
  if (patch.operators !== undefined) c.operators = patch.operators;
  if (patch.propertyIds !== undefined) {
    c.members = reconcileMembers(c.members, patch.propertyIds, new Date().toISOString());
    c.propertyIds = c.members.filter((m) => m.status === "active").map((m) => m.propertyId);
  }

  await writeOne(c);
  // A rename moves the record to a new key; drop the old one so the slug frees up.
  if (renamedFrom) await getConfigKV()?.delete(keyFor(renamedFrom));
  return { ok: true, collection: c };
}

export async function deleteCollection(slug: string): Promise<void> {
  await getConfigKV()?.delete(keyFor(normalizeSlug(slug)));
}

// ── Membership ───────────────────────────────────────────────────────────────
// Joining needs both sides; leaving needs one. The asymmetry between the two
// entry paths is deliberate and is about how bad the mistake is. A property
// appearing in one extra collection is small and reversible in a click, so a
// `curated` collection may add it straight away. A wrong property on a curated
// destination page breaks the page for everyone who visits meanwhile, so a
// request to join always waits for the operator.

export type AddOutcome =
  | { ok: true; status: "active" | "invited" }
  | { error: "not_found" | "private" | "blocked" | "already" };

const activeOrWaiting = (s: MemberStatus) => s === "active" || s === "invited" || s === "requested";

/** The operator adds a property. In `curated`/`open` it goes live immediately
 *  and the property can remove itself; in `official` it waits for the property
 *  to accept. `private` collections can only ever hold the operator's own
 *  properties, which is handled by the caller's own scoping — reaching here at
 *  all is a misuse, so it's refused rather than silently allowed. */
export async function addMemberByCollection(slug: string, propertyId: string): Promise<AddOutcome> {
  const c = await readOne(normalizeSlug(slug));
  if (!c) return { error: "not_found" };
  if (c.membershipMode === "private") return { error: "private" };

  const existing = c.members.find((m) => m.propertyId === propertyId);
  // A property that has refused this collection isn't asked again by adding.
  if (existing?.status === "declined") return { error: "blocked" };
  if (existing && activeOrWaiting(existing.status)) return { error: "already" };

  const now = new Date().toISOString();
  const status: MemberStatus = c.membershipMode === "official" ? "invited" : "active";
  const member: CollectionMember = {
    propertyId,
    status,
    initiatedBy: "collection",
    createdAt: now,
    activatedAt: status === "active" ? now : undefined,
  };
  c.members = [...c.members.filter((m) => m.propertyId !== propertyId), member];
  await writeOne(c);
  return { ok: true, status };
}

export type RequestOutcome =
  | { ok: true; status: "requested" | "active" }
  | { error: "not_found" | "not_open" | "already" };

/** A property asks to join. Only `open` admits without review — the curation is
 *  the operator's product, so `curated` queues a request and `official` and
 *  `private` don't accept them at all. */
export async function requestToJoin(slug: string, propertyId: string): Promise<RequestOutcome> {
  const c = await readOne(normalizeSlug(slug));
  if (!c) return { error: "not_found" };
  if (c.membershipMode === "private" || c.membershipMode === "official") return { error: "not_open" };

  const existing = c.members.find((m) => m.propertyId === propertyId);
  if (existing && activeOrWaiting(existing.status)) return { error: "already" };

  const now = new Date().toISOString();
  const status: MemberStatus = c.membershipMode === "open" ? "active" : "requested";
  c.members = [
    ...c.members.filter((m) => m.propertyId !== propertyId),
    {
      propertyId,
      status,
      initiatedBy: "property",
      createdAt: now,
      activatedAt: status === "active" ? now : undefined,
    },
  ];
  await writeOne(c);
  return { ok: true, status };
}

/** Moves a waiting membership to its conclusion. Used by the operator on a
 *  `requested` row and by the property on an `invited` one — the same two
 *  outcomes either way, so one function serves both sides. */
export async function resolveMembership(
  slug: string,
  propertyId: string,
  accept: boolean,
): Promise<boolean> {
  const c = await readOne(normalizeSlug(slug));
  const m = c?.members.find((x) => x.propertyId === propertyId);
  if (!c || !m || (m.status !== "invited" && m.status !== "requested")) return false;

  const now = new Date().toISOString();
  Object.assign(
    m,
    accept
      ? { status: "active" as const, activatedAt: now, endedAt: undefined }
      : { status: "declined" as const, endedAt: now },
  );
  await writeOne(c);
  return true;
}

/** Ends a membership. `block` marks it declined so the collection can't simply
 *  re-add the property; a plain leave allows a later invitation. Either side may
 *  call this — leaving never needs the other party's agreement. */
export async function endMembership(slug: string, propertyId: string, block = false): Promise<boolean> {
  const c = await readOne(normalizeSlug(slug));
  const m = c?.members.find((x) => x.propertyId === propertyId);
  if (!c || !m) return false;
  m.status = block ? "declined" : "left";
  m.endedAt = new Date().toISOString();
  await writeOne(c);
  return true;
}

export interface PropertyMembership {
  collection: Collection;
  member: CollectionMember;
}

export interface JoinableCollection {
  slug: string;
  name: string;
  destination?: string;
  mode: MembershipMode;
  /** Active members — a bare count, which is what a property weighing up
   *  whether a collection is worth joining actually needs. */
  memberCount: number;
  /** Which of the caller's properties could still ask. A property already in,
   *  already waiting, or that previously declined is not offered. */
  eligiblePropertyIds: string[];
}

/** Collections a property could ask to join.
 *
 *  Only `curated` and `open` accept requests at all — `official` is invite-only
 *  and `private` doesn't admit outsiders, so neither is listed here. `official`
 *  is a deliberate omission rather than an oversight: offering a request button
 *  that always fails is worse than not offering one. */
export async function joinableCollections(
  myPropertyIds: string[],
  operatedSlugs: Set<string> = new Set(),
): Promise<JoinableCollection[]> {
  if (myPropertyIds.length === 0) return [];
  const out: JoinableCollection[] = [];
  for (const c of await readAll()) {
    if (c.membershipMode !== "curated" && c.membershipMode !== "open") continue;
    if (c.directoryListed === false) continue;
    // Your own collections are managed directly; don't ask yourself.
    if (operatedSlugs.has(c.slug)) continue;

    const taken = new Set(
      c.members.filter((m) => m.status !== "left").map((m) => m.propertyId),
    );
    const eligiblePropertyIds = myPropertyIds.filter((id) => !taken.has(id));
    if (eligiblePropertyIds.length === 0) continue;

    out.push({
      slug: c.slug,
      name: c.name,
      destination: c.destination,
      mode: c.membershipMode,
      memberCount: c.members.filter((m) => m.status === "active").length,
      eligiblePropertyIds,
    });
  }
  return out.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
}

/** Emails that should hear about a collection's membership activity. */
export async function collectionOperatorEmails(slug: string): Promise<string[]> {
  const c = await readOne(normalizeSlug(slug));
  if (!c) return [];
  return [...new Set([c.owner, ...(c.operators ?? [])].filter((e): e is string => Boolean(e)))];
}

/** Every collection touching any of `propertyIds`, from the PROPERTY's point of
 *  view — what it's listed in, what it's been invited to, and what it has asked
 *  to join. This is what makes an immediate add fair: the property can always
 *  see where it appears and take itself out. */
export async function membershipsForProperties(propertyIds: string[]): Promise<PropertyMembership[]> {
  if (propertyIds.length === 0) return [];
  const ids = new Set(propertyIds);
  const out: PropertyMembership[] = [];
  for (const collection of await readAll()) {
    for (const member of collection.members) {
      if (ids.has(member.propertyId) && activeOrWaiting(member.status)) out.push({ collection, member });
    }
  }
  return out;
}
