// Property registry for the multi-property admin. The data layer is already
// keyed by property id (catalog_rooms:{id}, settings:{id}, …); this just tracks
// which ids exist and which one the admin is currently editing (stored in the
// signed admin session). User accounts / per-user access come later.
import { getAdminEmail, getSessionProperty } from "./auth.server";
import { getConfig, getConfigKV } from "./config.server";
import { getOverrides } from "./overrides.server";
import { isSuperadmin } from "./users.server";

export interface PropertyRef {
  id: string;
  name: string;
  /** Listed on the public root picker. Opt-in so staging/test properties stay
   *  off the public page; the seeded default property is public. */
  public?: boolean;
  /** Email of the user who owns (can see/edit) this property. Ownerless =
   *  legacy/unclaimed → visible to superadmins only. */
  owner?: string;
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

/** Properties the signed-in user may see/edit: superadmins see all; members see
 *  only the ones they own. This is the isolation chokepoint — every admin route
 *  resolves its active property through currentPropertyId(), which is scoped to
 *  this list. */
export async function getVisibleProperties(request: Request): Promise<PropertyRef[]> {
  const email = await getAdminEmail(request);
  if (!email) return [];
  const list = await getProperties();
  if (await isSuperadmin(email)) return list;
  return list.filter((p) => p.owner === email);
}

/** Whether the signed-in user may act on a specific property. */
export async function canAccess(request: Request, id: string): Promise<boolean> {
  return (await getVisibleProperties(request)).some((p) => p.id === id);
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
