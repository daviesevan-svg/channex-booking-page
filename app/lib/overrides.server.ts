import type { RatePlan, RoomWithRates } from "./channex/types";
import { getConfigKV } from "./config.server";
import {
  DEFAULT_LANG,
  isDeadlineUnit,
  isThemeId,
  normalizeHex,
  pageDef,
  searchDefaults,
  withDefaults,
  type DeadlineUnit,
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

// ===== rate-plan overrides (text localized; images shared) =====
// Rate plans are mapped by their (logical) title, not by Channex id — Channex
// splits one rate into many ids (per room, per occupancy), but the admin edits
// a single "Breakfast Rate" entry that applies wherever that title is offered.
export function rateKey(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "rate"
  );
}
export interface RatePlanOverride {
  name?: string;
  description?: string;
  inclusions?: string[];
  /** Cancellation policy text shown to guests (overrides the Channex title). */
  cancellation?: string;
  images?: string[];
  // ----- structured policy (language-agnostic; stored on the default-lang entry) -----
  refundable?: boolean;
  cancelDeadlineValue?: number;
  cancelDeadlineUnit?: DeadlineUnit;
  modifyDeadlineValue?: number;
  modifyDeadlineUnit?: DeadlineUnit;
}
const POLICY_KEYS = [
  "refundable",
  "cancelDeadlineValue",
  "cancelDeadlineUnit",
  "modifyDeadlineValue",
  "modifyDeadlineUnit",
] as const;
function pickPolicy(e: RatePlanOverride | undefined): Partial<RatePlanOverride> {
  const out: Partial<RatePlanOverride> = {};
  if (!e) return out;
  for (const k of POLICY_KEYS) if (e[k] !== undefined) (out as Record<string, unknown>)[k] = e[k];
  return out;
}
type RatePlanOverridesMap = Record<string, RatePlanOverride>;
const ratePlansKey = (pid: string) => `rateplans:${pid}`;
const ratePlansMap = (pid: string) =>
  readJson<LangMap<RatePlanOverridesMap>>(ratePlansKey(pid)).then((m) => m ?? {});

/** Merged for guests: language text over default text; images from the default language. */
export async function getRatePlanOverrides(
  pid: string,
  lang = DEFAULT_LANG,
): Promise<RatePlanOverridesMap> {
  const m = await ratePlansMap(pid);
  const base = m[DEFAULT_LANG] ?? {};
  const loc = m[lang] ?? {};
  const out: RatePlanOverridesMap = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(loc)])) {
    out[id] = {
      name: loc[id]?.name ?? base[id]?.name,
      description: loc[id]?.description ?? base[id]?.description,
      inclusions: loc[id]?.inclusions ?? base[id]?.inclusions,
      cancellation: loc[id]?.cancellation ?? base[id]?.cancellation,
      images: base[id]?.images,
      ...pickPolicy(base[id]),
    };
  }
  return out;
}
/** Admin prefill: this language's text + the shared (default-language) images. */
export async function getRatePlanOverride(
  pid: string,
  rateId: string,
  lang: string,
): Promise<RatePlanOverride> {
  const m = await ratePlansMap(pid);
  const langEntry = (m[lang] ?? {})[rateId] ?? {};
  const baseEntry = (m[DEFAULT_LANG] ?? {})[rateId] ?? {};
  return {
    name: langEntry.name,
    description: langEntry.description,
    inclusions: langEntry.inclusions,
    cancellation: langEntry.cancellation,
    images: baseEntry.images,
    ...pickPolicy(baseEntry),
  };
}
export async function putRatePlanOverride(
  pid: string,
  rateId: string,
  lang: string,
  ov: RatePlanOverride,
): Promise<void> {
  const m = await ratePlansMap(pid);
  const name = ov.name?.trim() || undefined;
  const description = ov.description?.trim() || undefined;
  const inclusions = (ov.inclusions ?? []).map((s) => s.trim()).filter(Boolean);
  const cancellation = ov.cancellation?.trim() || undefined;
  const images = (ov.images ?? []).map((s) => s.trim()).filter(Boolean);

  // Text for this language.
  const langMap = { ...(m[lang] ?? {}) };
  const textEntry: RatePlanOverride = {};
  if (name) textEntry.name = name;
  if (description) textEntry.description = description;
  if (inclusions.length) textEntry.inclusions = inclusions;
  if (cancellation) textEntry.cancellation = cancellation;
  if (Object.keys(textEntry).length) langMap[rateId] = textEntry;
  else delete langMap[rateId];
  m[lang] = langMap;

  // Images + structured policy are language-agnostic — stored on the default-language entry.
  const baseMap = { ...(m[DEFAULT_LANG] ?? {}) };
  const baseEntry: RatePlanOverride = { ...(baseMap[rateId] ?? {}) };
  baseEntry.images = images.length ? images : undefined;
  baseEntry.refundable = ov.refundable;
  baseEntry.cancelDeadlineValue = ov.cancelDeadlineValue;
  baseEntry.cancelDeadlineUnit = ov.cancelDeadlineUnit;
  baseEntry.modifyDeadlineValue = ov.modifyDeadlineValue;
  baseEntry.modifyDeadlineUnit = ov.modifyDeadlineUnit;
  for (const k of ["images", ...POLICY_KEYS] as const) {
    if (baseEntry[k] === undefined) delete baseEntry[k];
  }
  if (Object.keys(baseEntry).length) baseMap[rateId] = baseEntry;
  else delete baseMap[rateId];
  m[DEFAULT_LANG] = baseMap;

  await writeJson(ratePlansKey(pid), m);
}

/** Apply a rate-plan content override on top of a Channex rate plan. */
export function mergeRatePlanOverride(plan: RatePlan, ov?: RatePlanOverride): RatePlan {
  if (!ov) return plan;
  const merged: RatePlan = { ...plan };
  if (ov.name) merged.title = ov.name;
  if (ov.description) merged.description = ov.description;
  if (ov.inclusions?.length) merged.inclusions = ov.inclusions;
  if (ov.images?.length) merged.images = ov.images;
  if (ov.cancellation) merged.cancellationNote = ov.cancellation;
  return merged;
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
  const d = searchDefaults(lang);
  return {
    eyebrow: loc.eyebrow ?? base.eyebrow,
    heading: loc.heading ?? base.heading ?? d.heading,
    intro: loc.intro ?? base.intro ?? d.intro,
    promoText: loc.promoText ?? base.promoText ?? d.promoText,
    searchButton: loc.searchButton ?? base.searchButton ?? d.searchButton,
    highlights: loc.highlights ?? base.highlights ?? d.highlights,
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
  return withDefaults(pageId, { ...base, ...loc }, lang);
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
  const existing = await getSettings(pid);
  const themeRaw = String(form.get("theme") ?? "").trim();
  const next: SiteSettings = {
    ...existing,
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

const posInt = (v: FormDataEntryValue | null): number | undefined => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export async function savePortalSettings(pid: string, form: FormData): Promise<SiteSettings> {
  const existing = await getSettings(pid);
  const unit = (k: string) => {
    const u = String(form.get(k) ?? "");
    return isDeadlineUnit(u) ? u : undefined;
  };
  const next: SiteSettings = {
    ...existing,
    allowCancel: form.get("allowCancel") === "on",
    allowModify: form.get("allowModify") === "on",
    cancelDeadlineValue: posInt(form.get("cancelDeadlineValue")),
    cancelDeadlineUnit: unit("cancelDeadlineUnit"),
    modifyDeadlineValue: posInt(form.get("modifyDeadlineValue")),
    modifyDeadlineUnit: unit("modifyDeadlineUnit"),
    afterDeadlineMessage: String(form.get("afterDeadlineMessage") ?? "").trim() || undefined,
  };
  await writeJson(settingsKey(pid), next);
  return next;
}
