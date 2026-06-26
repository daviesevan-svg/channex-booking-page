// Property registry for the multi-property admin. The data layer is already
// keyed by property id (catalog_rooms:{id}, settings:{id}, …); this just tracks
// which ids exist and which one the admin is currently editing (stored in the
// signed admin session). User accounts / per-user access come later.
import { getSessionProperty } from "./auth.server";
import { getConfig, getConfigKV } from "./config.server";
import { getOverrides } from "./overrides.server";

export interface PropertyRef {
  id: string;
  name: string;
  /** Listed on the public root picker. Opt-in so staging/test properties stay
   *  off the public page; the seeded default property is public. */
  public?: boolean;
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

export async function addProperty(id: string, name: string): Promise<PropertyRef> {
  const list = await getProperties();
  const ref: PropertyRef = { id, name: name.trim() || "Untitled property" };
  if (!list.some((p) => p.id === id)) {
    list.push(ref);
    await write(list);
  }
  return ref;
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
 *  still a valid property, else the first registered (or DEFAULT_PROPERTY_ID). */
export async function currentPropertyId(request: Request): Promise<string | undefined> {
  const list = await getProperties();
  const selected = await getSessionProperty(request);
  if (selected && list.some((p) => p.id === selected)) return selected;
  return list[0]?.id ?? getConfig().defaultPropertyId;
}
