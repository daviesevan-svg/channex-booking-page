// Collections: an owner-curated group of properties presented on one branded
// landing page at /c/:slug — the "choose where you'll stay" screen for a host
// with several places (e.g. apartments in different locations). A collection is
// purely a presentation layer over existing properties: each member property
// keeps its own data, calendar, rates and booking flow. Stored under a single KV
// key like the property registry (admin-curated, low write volume).
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
  /** Member property ids, in display order. */
  propertyIds: string[];
  /** Shared theme for the landing (mirrors SiteSettings theming). */
  theme?: SiteSettings["theme"];
  customColor?: string;
  customBg?: string;
  themeFont?: string;
  /** Owning user's email (scoping). */
  owner?: string;
}

const KEY = "collections";

async function read(): Promise<Collection[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as Collection[]) : [];
  } catch {
    return [];
  }
}

async function write(list: Collection[]): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(KEY, JSON.stringify(list));
}

export async function getCollections(): Promise<Collection[]> {
  return read();
}

/** A single collection by slug (unscoped — public landing uses this). */
export async function getCollectionBySlug(slug: string): Promise<Collection | undefined> {
  const s = normalizeSlug(slug);
  if (!s) return undefined;
  return (await read()).find((c) => c.slug === s);
}

/** Collections the signed-in user may see/edit: superadmins see all; everyone
 *  else sees the ones they own. */
export async function getVisibleCollections(request: Request): Promise<Collection[]> {
  const email = await getAdminEmail(request);
  if (!email) return [];
  const list = await read();
  if (await isSuperadmin(email)) return list;
  return list.filter((c) => c.owner === email);
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
  const list = await read();
  const clean = name.trim() || "New collection";
  // Derive a unique slug: base from the name, then -2, -3… until free.
  let base = slugify(clean);
  if (base.length < 3) base = `collection-${base}`.slice(0, 50);
  let slug = base;
  let n = 2;
  while (list.some((c) => c.slug === slug) || RESERVED_SLUGS.has(slug)) {
    slug = `${base}-${n++}`.slice(0, 50);
  }
  const col: Collection = { slug, name: clean, propertyIds: [], owner };
  list.push(col);
  await write(list);
  return col;
}

/** Merge-updates a collection's editable fields (never its owner). Slug changes
 *  are validated; an invalid slug is rejected (returns {error}) without saving. */
export async function updateCollection(
  slug: string,
  patch: Partial<Omit<Collection, "owner">>,
): Promise<{ ok: true; collection: Collection } | { error: string }> {
  const list = await read();
  const c = list.find((x) => x.slug === normalizeSlug(slug));
  if (!c) return { error: "Collection not found." };

  if (patch.slug !== undefined) {
    const s = normalizeSlug(patch.slug);
    const err = collectionSlugError(s, c.slug, list);
    if (err) return { error: err };
    c.slug = s;
  }
  if (patch.name !== undefined) c.name = patch.name.trim() || c.name;
  if (patch.destination !== undefined) c.destination = patch.destination.trim() || undefined;
  if (patch.heading !== undefined) c.heading = patch.heading.trim() || undefined;
  if (patch.intro !== undefined) c.intro = patch.intro.trim() || undefined;
  if (patch.phone !== undefined) c.phone = patch.phone.trim() || undefined;
  if (patch.propertyIds !== undefined) c.propertyIds = patch.propertyIds;
  if (patch.theme !== undefined) c.theme = patch.theme;
  if (patch.customColor !== undefined) c.customColor = patch.customColor || undefined;
  if (patch.customBg !== undefined) c.customBg = patch.customBg || undefined;
  if (patch.themeFont !== undefined) c.themeFont = patch.themeFont || undefined;

  await write(list);
  return { ok: true, collection: c };
}

export async function deleteCollection(slug: string): Promise<void> {
  await write((await read()).filter((c) => c.slug !== normalizeSlug(slug)));
}
