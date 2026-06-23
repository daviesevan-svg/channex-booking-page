import type { RoomWithRates } from "./channex/types";
import { getConfigKV } from "./config.server";
import {
  DEFAULT_LANG,
  isThemeId,
  normalizeHex,
  pageDef,
  withDefaults,
  type SearchContent,
  type SiteSettings,
} from "./content";

// Localized content is stored per language: KV value is { [lang]: data }.
// Guests read their language merged over the default language; the admin edits
// one language at a time (raw values for that language).
type LangMap<T> = Record<string, T>;

async function readJson<T>(key: string): Promise<T | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
async function writeJson(key: string, value: unknown): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(key, JSON.stringify(value));
}

// ===== property overrides (localized) =====
export interface PropertyOverrides {
  hotelName?: string;
  address?: string;
  description?: string;
  phone?: string;
  email?: string;
}
const OVERRIDE_FIELDS: (keyof PropertyOverrides)[] = [
  "hotelName",
  "address",
  "description",
  "phone",
  "email",
];
const overridesKey = (pid: string) => `overrides:${pid}`;
const overridesMap = (pid: string) =>
  readJson<LangMap<PropertyOverrides>>(overridesKey(pid)).then((m) => m ?? {});

export async function getOverrides(pid: string, lang = DEFAULT_LANG): Promise<PropertyOverrides> {
  const m = await overridesMap(pid);
  return { ...(m[DEFAULT_LANG] ?? {}), ...(m[lang] ?? {}) };
}
export async function getOverridesRaw(pid: string, lang: string): Promise<PropertyOverrides> {
  return (await overridesMap(pid))[lang] ?? {};
}
export async function saveOverrides(
  pid: string,
  lang: string,
  input: Record<string, FormDataEntryValue>,
): Promise<void> {
  const next: PropertyOverrides = {};
  for (const f of OVERRIDE_FIELDS) {
    const v = String(input[f] ?? "").trim();
    if (v) next[f] = v;
  }
  const m = await overridesMap(pid);
  m[lang] = next;
  await writeJson(overridesKey(pid), m);
}

// ===== room overrides (name/description localized; images shared) =====
export interface RoomOverride {
  name?: string;
  description?: string;
  images?: string[];
}
type RoomOverridesMap = Record<string, RoomOverride>;
const roomsKey = (pid: string) => `rooms:${pid}`;
const roomsMap = (pid: string) =>
  readJson<LangMap<RoomOverridesMap>>(roomsKey(pid)).then((m) => m ?? {});

/** Merged for guests: language text over default text; images from the default language. */
export async function getRoomOverrides(pid: string, lang = DEFAULT_LANG): Promise<RoomOverridesMap> {
  const m = await roomsMap(pid);
  const base = m[DEFAULT_LANG] ?? {};
  const loc = m[lang] ?? {};
  const out: RoomOverridesMap = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(loc)])) {
    out[id] = {
      name: loc[id]?.name ?? base[id]?.name,
      description: loc[id]?.description ?? base[id]?.description,
      images: base[id]?.images,
    };
  }
  return out;
}
/** Admin prefill: this language's text + the shared (default-language) images. */
export async function getRoomOverride(
  pid: string,
  roomId: string,
  lang: string,
): Promise<RoomOverride> {
  const m = await roomsMap(pid);
  const langEntry = (m[lang] ?? {})[roomId] ?? {};
  const baseEntry = (m[DEFAULT_LANG] ?? {})[roomId] ?? {};
  return { name: langEntry.name, description: langEntry.description, images: baseEntry.images };
}
export async function putRoomOverride(
  pid: string,
  roomId: string,
  lang: string,
  ov: RoomOverride,
): Promise<void> {
  const m = await roomsMap(pid);
  const name = ov.name?.trim() || undefined;
  const description = ov.description?.trim() || undefined;
  const images = (ov.images ?? []).map((s) => s.trim()).filter(Boolean);

  // Text for this language.
  const langMap = { ...(m[lang] ?? {}) };
  const textEntry: RoomOverride = {};
  if (name) textEntry.name = name;
  if (description) textEntry.description = description;
  if (Object.keys(textEntry).length) langMap[roomId] = textEntry;
  else delete langMap[roomId];
  m[lang] = langMap;

  // Images are shared — always stored on the default-language entry.
  const baseMap = { ...(m[DEFAULT_LANG] ?? {}) };
  const baseEntry = { ...(baseMap[roomId] ?? {}) };
  if (images.length) baseEntry.images = images;
  else delete baseEntry.images;
  if (Object.keys(baseEntry).length) baseMap[roomId] = baseEntry;
  else delete baseMap[roomId];
  m[DEFAULT_LANG] = baseMap;

  await writeJson(roomsKey(pid), m);
}

/** Apply a room's content override on top of the Channex room (keeps rate plans). */
export function mergeRoomOverride(room: RoomWithRates, ov?: RoomOverride): RoomWithRates {
  if (!ov) return room;
  return {
    ...room,
    title: ov.name || room.title,
    description: ov.description || room.description,
    photos: ov.images?.length ? ov.images.map((url) => ({ url })) : room.photos,
  };
}

// ===== editable page content (localized) =====
interface SiteContent {
  search?: SearchContent;
  pages?: Record<string, Record<string, string>>;
}
const contentKey = (pid: string) => `content:${pid}`;
const contentMap = (pid: string) =>
  readJson<LangMap<SiteContent>>(contentKey(pid)).then((m) => m ?? {});

export async function getSearchContent(pid: string, lang = DEFAULT_LANG): Promise<SearchContent> {
  const m = await contentMap(pid);
  const base = m[DEFAULT_LANG]?.search ?? {};
  const loc = m[lang]?.search ?? {};
  return {
    eyebrow: loc.eyebrow ?? base.eyebrow,
    heading: loc.heading ?? base.heading,
    intro: loc.intro ?? base.intro,
    promoText: loc.promoText ?? base.promoText,
    searchButton: loc.searchButton ?? base.searchButton,
    highlights: loc.highlights ?? base.highlights,
  };
}
export async function getSearchContentRaw(pid: string, lang: string): Promise<SearchContent> {
  return (await contentMap(pid))[lang]?.search ?? {};
}
export async function saveSearchContent(
  pid: string,
  lang: string,
  search: SearchContent,
): Promise<void> {
  const m = await contentMap(pid);
  m[lang] = { ...(m[lang] ?? {}), search };
  await writeJson(contentKey(pid), m);
}

export async function getPageText(
  pid: string,
  pageId: string,
  lang = DEFAULT_LANG,
): Promise<Record<string, string>> {
  const m = await contentMap(pid);
  const base = m[DEFAULT_LANG]?.pages?.[pageId] ?? {};
  const loc = m[lang]?.pages?.[pageId] ?? {};
  return withDefaults(pageId, { ...base, ...loc });
}
export async function getPageOverridesRaw(
  pid: string,
  pageId: string,
  lang: string,
): Promise<Record<string, string>> {
  const m = await contentMap(pid);
  return m[lang]?.pages?.[pageId] ?? {};
}
export async function savePageContent(
  pid: string,
  pageId: string,
  lang: string,
  input: Record<string, FormDataEntryValue>,
): Promise<void> {
  const def = pageDef(pageId);
  if (!def) return;
  const data: Record<string, string> = {};
  for (const f of def.fields) {
    const v = String(input[f.key] ?? "").trim();
    if (v) data[f.key] = v;
  }
  const m = await contentMap(pid);
  const entry = m[lang] ?? {};
  entry.pages = { ...(entry.pages ?? {}), [pageId]: data };
  m[lang] = entry;
  await writeJson(contentKey(pid), m);
}

// ===== general site settings (global, not localized) =====
const settingsKey = (pid: string) => `settings:${pid}`;

export async function getSettings(pid: string): Promise<SiteSettings> {
  return (await readJson<SiteSettings>(settingsKey(pid))) ?? {};
}
export async function saveSettings(pid: string, form: FormData): Promise<SiteSettings> {
  const themeRaw = String(form.get("theme") ?? "").trim();
  const next: SiteSettings = {
    theme: themeRaw === "custom" || isThemeId(themeRaw) ? (themeRaw as SiteSettings["theme"]) : undefined,
    customColor: normalizeHex(String(form.get("customColor") ?? "")),
    customBg: normalizeHex(String(form.get("customBg") ?? "")),
    customDomain:
      String(form.get("customDomain") ?? "")
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "") || undefined,
    languages: form.getAll("languages").map(String),
  };
  await writeJson(settingsKey(pid), next);
  return next;
}
