import { getConfigKV } from "./config.server";
import {
  DEFAULT_LANG,
  isDeadlineUnit,
  isThemeId,
  normalizeHex,
  pageDef,
  searchDefaults,
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
    heroImage: base.heroImage, // language-independent — always from the base entry
  };
}
export async function getSearchContentRaw(pid: string, lang: string): Promise<SearchContent> {
  return (await contentMap(pid))[lang]?.search ?? {};
}
/** The hero image lives on the default-language base entry, regardless of which
 *  language tab is being edited. */
export async function getHeroImage(pid: string): Promise<string | undefined> {
  return (await contentMap(pid))[DEFAULT_LANG]?.search?.heroImage;
}
export async function saveHeroImage(pid: string, url: string | null): Promise<void> {
  const m = await contentMap(pid);
  const base = m[DEFAULT_LANG] ?? {};
  m[DEFAULT_LANG] = {
    ...base,
    search: { ...(base.search ?? {}), heroImage: url ?? undefined },
  };
  await writeJson(contentKey(pid), m);
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
    currency: String(form.get("currency") ?? "").trim().toUpperCase() || undefined,
    languages: form.getAll("languages").map(String),
    liveBooking: form.get("liveBooking") === "on",
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
