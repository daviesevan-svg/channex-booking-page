import { getConfigKV } from "./config.server";
import type { CityTaxConfig, FeeRule, TaxRule } from "./pricing";
import {
  bookingCutoffOf,
  DEFAULT_LANG,
  DEFAULT_PROMO_PLACEHOLDER,
  emailDef,
  isDeadlineUnit,
  isThemeId,
  normalizeHex,
  pageDef,
  searchDefaults,
  withDefaults,
  withEmailDefaults,
  type BookingCutoff,
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
    promoPlaceholder: loc.promoPlaceholder ?? base.promoPlaceholder ?? DEFAULT_PROMO_PLACEHOLDER,
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

// ===== editable email templates (localized) =====
interface EmailContent {
  templates?: Record<string, Record<string, string>>;
}
const emailContentKey = (pid: string) => `email_content:${pid}`;
const emailContentMap = (pid: string) =>
  readJson<LangMap<EmailContent>>(emailContentKey(pid)).then((m) => m ?? {});

/** Merged template fields (defaults + base[en] + lang overrides). */
export async function getEmailTemplate(
  pid: string,
  id: string,
  lang = DEFAULT_LANG,
): Promise<Record<string, string>> {
  const m = await emailContentMap(pid);
  const base = m[DEFAULT_LANG]?.templates?.[id] ?? {};
  const loc = m[lang]?.templates?.[id] ?? {};
  return withEmailDefaults(id, { ...base, ...loc }, lang);
}
export async function getEmailOverridesRaw(
  pid: string,
  id: string,
  lang: string,
): Promise<Record<string, string>> {
  const m = await emailContentMap(pid);
  return m[lang]?.templates?.[id] ?? {};
}
export async function saveEmailContent(
  pid: string,
  id: string,
  lang: string,
  input: Record<string, FormDataEntryValue>,
): Promise<void> {
  const def = emailDef(id);
  if (!def) return;
  const data: Record<string, string> = {};
  for (const f of def.fields) {
    const v = String(input[f.key] ?? "").trim();
    if (v) data[f.key] = v;
  }
  const m = await emailContentMap(pid);
  const entry = m[lang] ?? {};
  entry.templates = { ...(entry.templates ?? {}), [id]: data };
  m[lang] = entry;
  await writeJson(emailContentKey(pid), m);
}

const cleanEmail = (v: FormDataEntryValue | null): string | undefined => {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : undefined;
};

/** Email sender identity + host-notification settings. Merges into existing
 *  settings (doesn't reuse saveSettings, which would clobber other fields). */
export async function saveEmailSettings(pid: string, form: FormData): Promise<SiteSettings> {
  const existing = await getSettings(pid);
  const next: SiteSettings = {
    ...existing,
    emailFromName: String(form.get("emailFromName") ?? "").trim() || undefined,
    emailReplyTo: cleanEmail(form.get("emailReplyTo")),
    hostNotifyEmail: cleanEmail(form.get("hostNotifyEmail")),
    notifyHostOnBooking: form.get("notifyHostOnBooking") === "on",
    notifyHostOnCancel: form.get("notifyHostOnCancel") === "on",
  };
  await writeJson(settingsKey(pid), next);
  return next;
}

// ===== general site settings (global, not localized) =====
const settingsKey = (pid: string) => `settings:${pid}`;

export async function getSettings(pid: string): Promise<SiteSettings> {
  return (await readJson<SiteSettings>(settingsKey(pid))) ?? {};
}
/** Accept only http(s) URLs; otherwise drop (so a bad value never becomes a link). */
function safeUrl(v: FormDataEntryValue | null): string | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
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
    termsUrl: safeUrl(form.get("termsUrl")),
    privacyUrl: safeUrl(form.get("privacyUrl")),
    languages: form.getAll("languages").map(String),
    liveBooking: form.get("liveBooking") === "on",
    timezone: cleanTimezone(form.get("timezone")),
    bookingCutoffDays: cutoffDays(form.get("bookingCutoffDays")),
    bookingCutoffTime: cleanTime(form.get("bookingCutoffTime")),
  };
  await writeJson(settingsKey(pid), next);
  return next;
}

/** Merge the property-level Google/location/check-in fields into settings without
 *  touching the rest (these are edited on the Property details page, not General,
 *  so we must not clobber theme/currency/etc.). */
export async function savePropertyMeta(pid: string, form: FormData): Promise<SiteSettings> {
  const existing = await getSettings(pid);
  const next: SiteSettings = {
    ...existing,
    checkinTime: cleanTime(form.get("checkinTime")),
    checkoutTime: cleanTime(form.get("checkoutTime")),
    addressCity: String(form.get("addressCity") ?? "").trim() || undefined,
    addressRegion: String(form.get("addressRegion") ?? "").trim() || undefined,
    addressPostalCode: String(form.get("addressPostalCode") ?? "").trim() || undefined,
    addressCountry: String(form.get("addressCountry") ?? "").trim().toUpperCase().slice(0, 2) || undefined,
    latitude: cleanCoord(form.get("latitude")),
    longitude: cleanCoord(form.get("longitude")),
    googleStructuredData: form.get("googleStructuredData") === "on",
  };
  await writeJson(settingsKey(pid), next);
  return next;
}

/** A valid IANA timezone string, or undefined. */
function cleanTimezone(v: FormDataEntryValue | null): string | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: s });
    return s;
  } catch {
    return undefined;
  }
}

/** Lead-time days: "" / "off" = no limit; 0-7 = required lead (0 = same-day). */
function cutoffDays(v: FormDataEntryValue | null): number | undefined {
  const s = String(v ?? "").trim();
  if (s === "" || s === "off") return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 && n <= 7 ? n : undefined;
}

/** Normalize an "HH:MM" time, or undefined if malformed. */
function cleanTime(v: FormDataEntryValue | null): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** A decimal-degrees coordinate, kept as a normalized string (or undefined). */
function cleanCoord(v: FormDataEntryValue | null): string | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : undefined;
}

/** The property's booking lead-time cutoff, for the guest-flow date guards. */
export async function getBookingCutoff(pid: string): Promise<BookingCutoff> {
  return bookingCutoffOf(await getSettings(pid));
}

/** True only when this property has explicitly selected Channex on the
 *  Connectivity page. Gates all inbound Channex sync + outbound booking push. */
export async function isChannexConnected(pid: string): Promise<boolean> {
  if (!pid) return false;
  return (await getSettings(pid)).connectedSystem === "channex";
}

/** Set (or clear, with undefined) the connected channel-manager/PMS system.
 *  Merges into existing settings rather than rewriting the whole form. */
export async function saveConnectivity(pid: string, system: string | undefined): Promise<SiteSettings> {
  const existing = await getSettings(pid);
  const next: SiteSettings = { ...existing, connectedSystem: system || undefined };
  await writeJson(settingsKey(pid), next);
  return next;
}

/** Merge the Google Hotels ARI push settings (enable toggle + window). Leaves the
 *  rest of settings untouched. */
export async function saveGoogleAriSettings(
  pid: string,
  input: { push: boolean; windowDays?: number },
): Promise<SiteSettings> {
  const existing = await getSettings(pid);
  const n = input.windowDays;
  const windowDays = Number.isFinite(n) && (n as number) > 0 ? Math.min(500, Math.round(n as number)) : undefined;
  const next: SiteSettings = { ...existing, googleAriPush: input.push, googleAriWindowDays: windowDays };
  await writeJson(settingsKey(pid), next);
  return next;
}

/** Record the outcome of a Google ARI push so the admin can show last-sync state. */
export async function recordGoogleAriSync(
  pid: string,
  lastSync: NonNullable<SiteSettings["googleAriLastSync"]>,
): Promise<void> {
  const existing = await getSettings(pid);
  await writeJson(settingsKey(pid), { ...existing, googleAriLastSync: lastSync });
}

/** Set/clear the property's connected Stripe account (merge-style). Passing
 *  undefined for `accountId` disconnects. */
export async function savePaymentSettings(
  pid: string,
  patch: { stripeAccountId?: string; stripeChargesEnabled?: boolean },
): Promise<SiteSettings> {
  const existing = await getSettings(pid);
  const next: SiteSettings = {
    ...existing,
    stripeAccountId: patch.stripeAccountId || undefined,
    stripeChargesEnabled: patch.stripeAccountId ? patch.stripeChargesEnabled ?? false : undefined,
  };
  await writeJson(settingsKey(pid), next);
  return next;
}

const posInt = (v: FormDataEntryValue | null): number | undefined => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// ===== taxes & fees =====
const num = (v: unknown, min = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : min;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const rid = () => Math.random().toString(36).slice(2, 10);

function parseJson<T>(form: FormData, key: string): T[] {
  try {
    const v = JSON.parse(String(form.get(key) ?? "[]"));
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export async function saveTaxSettings(pid: string, form: FormData): Promise<SiteSettings> {
  const existing = await getSettings(pid);

  const taxes: TaxRule[] = parseJson<Partial<TaxRule>>(form, "taxesJson")
    .map((t) => ({
      id: String(t.id || rid()),
      name: String(t.name ?? "").trim() || "VAT",
      rate: clamp(num(t.rate), 0, 100),
    }))
    .filter((t) => t.rate > 0);

  const fees: FeeRule[] = parseJson<Partial<FeeRule>>(form, "feesJson")
    .map((f): FeeRule => ({
      id: String(f.id || rid()),
      name: String(f.name ?? "").trim() || "Fee",
      kind: f.kind === "fixed" ? "fixed" : "percent",
      amount: num(f.amount),
      taxable: f.taxable === true,
    }))
    .filter((f) => f.amount > 0);

  const ctRaw = parseJson<Partial<CityTaxConfig>>(form, "cityTaxJson")[0];
  const cityTax: CityTaxConfig | undefined = ctRaw
    ? {
        enabled: ctRaw.enabled === true,
        name: String(ctRaw.name ?? "").trim() || "City tax",
        amount: num(ctRaw.amount),
        basis:
          ctRaw.basis === "room_night" || ctRaw.basis === "room_stay"
            ? ctRaw.basis
            : "person_night",
        taxable: ctRaw.taxable === true,
        childrenExempt: ctRaw.childrenExempt === true,
        maxNights: Math.round(num(ctRaw.maxNights)),
      }
    : undefined;

  const next: SiteSettings = {
    ...existing,
    taxesInclusive: form.get("taxesInclusive") === "on",
    taxes,
    fees,
    cityTax,
  };
  await writeJson(settingsKey(pid), next);
  return next;
}

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
    autoRefund: form.get("autoRefund") === "on",
    cancelDeadlineValue: posInt(form.get("cancelDeadlineValue")),
    cancelDeadlineUnit: unit("cancelDeadlineUnit"),
    modifyDeadlineValue: posInt(form.get("modifyDeadlineValue")),
    modifyDeadlineUnit: unit("modifyDeadlineUnit"),
    afterDeadlineMessage: String(form.get("afterDeadlineMessage") ?? "").trim() || undefined,
  };
  await writeJson(settingsKey(pid), next);
  return next;
}
