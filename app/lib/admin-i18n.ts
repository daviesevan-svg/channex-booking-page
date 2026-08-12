// Admin-UI translations. Separate from the guest i18n (app/lib/i18n.ts): the
// guest dictionary follows the property's enabled languages, while this one
// follows the signed-in admin's own preference — a cookie set from the header
// picker, defaulting to the browser's Accept-Language. English is the
// fallback for any missing key, so partially translated pages degrade
// gracefully rather than breaking.
//
// Only ENGLISH is bundled for the browser — it is the default and the per-key
// fallback. The other five dictionaries live in ./admin-locales/*, are imported
// on the server only (admin-i18n-locales.server.ts), and the active one reaches
// the browser as root loader data, registered by root's Layout before anything
// renders. Same shape as the guest split in i18n.ts, for the same reason: they
// were a 755 kB chunk loaded by every admin page.
import {
  de as deDateLocale,
  el as elDateLocale,
  pt as ptDateLocale,
  th as thDateLocale,
  tr as trDateLocale,
} from "date-fns/locale";
import type { Locale } from "date-fns";
import { useRouteLoaderData } from "react-router";

import EN from "./admin-locales/en";

export type AdminLang = "en" | "de" | "pt" | "el" | "th" | "tr";
/** Flags are spelled out here rather than read from `LANGUAGES` in content.ts:
 *  the admin's languages are deliberately independent of the guest ones (a
 *  guest language can be dropped without touching the admin panel), and the
 *  emoji must not silently become undefined when that happens. */
export const ADMIN_LANGS: { id: AdminLang; label: string; flag: string }[] = [
  { id: "en", label: "English", flag: "🇬🇧" },
  { id: "de", label: "Deutsch", flag: "🇩🇪" },
  { id: "pt", label: "Português", flag: "🇵🇹" },
  { id: "el", label: "Ελληνικά", flag: "🇬🇷" },
  { id: "th", label: "ไทย", flag: "🇹🇭" },
  { id: "tr", label: "Türkçe", flag: "🇹🇷" },
];
export const ADMIN_LANG_COOKIE = "admin_lang";
export const DEFAULT_ADMIN_LANG: AdminLang = "en";

export function isAdminLang(v: string): v is AdminLang {
  return ADMIN_LANGS.some((l) => l.id === v);
}

/** The admin's UI language: the picker cookie wins; first visits fall back to
 *  the browser's preferred language. */
export function adminLangFromRequest(request: Request): AdminLang {
  const cookie = request.headers.get("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)admin_lang=([^;\s]+)/);
  if (m && isAdminLang(m[1])) return m[1];
  const accept = (request.headers.get("Accept-Language") ?? "").trim().toLowerCase();
  if (accept.startsWith("de")) return "de";
  if (accept.startsWith("pt")) return "pt";
  if (accept.startsWith("el")) return "el";
  if (accept.startsWith("th")) return "th";
  if (accept.startsWith("tr")) return "tr";
  return DEFAULT_ADMIN_LANG;
}

export type AdminT = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Dictionaries available to `adminT` right now. English is always here. On the
 * server, admin-i18n-locales.server.ts fills in the rest at module load. In the
 * browser only the admin's own language is ever added, so a miss means "not
 * this admin's language" and the per-key English fallback is the right answer.
 */
const DICTS = new Map<string, Record<string, string>>([["en", EN]]);

/** Register one language's labels. Idempotent — called on every render of
 *  root's Layout, which is what keeps a client-side language switch working. */
export function registerAdminDict(lang: string, dict: Record<string, string> | null | undefined): void {
  if (!dict || !lang || lang === "en") return;
  DICTS.set(lang, dict);
}

export function adminT(lang: AdminLang): AdminT {
  const dict = lang === "en" ? undefined : DICTS.get(lang);
  return (key, vars) => {
    let s = dict?.[key] ?? EN[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

/** The admin language for components under the admin layout — from the layout
 *  loader, so pages don't each need loader plumbing. */
export function useAdminLang(): AdminLang {
  const data = useRouteLoaderData("routes/admin/layout") as { adminLang?: AdminLang } | undefined;
  return data?.adminLang ?? DEFAULT_ADMIN_LANG;
}

/** t() for components under the admin layout. */
export function useAdminT(): AdminT {
  return adminT(useAdminLang());
}

/** date-fns locale matching the admin language (undefined = date-fns' English
 *  default). Pass to fmtDate/format for weekday/month names in the UI. */
const DATE_LOCALES: Record<Exclude<AdminLang, "en">, Locale> = {
  de: deDateLocale,
  pt: ptDateLocale,
  el: elDateLocale,
  th: thDateLocale,
  tr: trDateLocale,
};

export function adminDateLocale(lang: AdminLang): Locale | undefined {
  return lang === "en" ? undefined : DATE_LOCALES[lang];
}

export function useAdminDateLocale(): Locale | undefined {
  return adminDateLocale(useAdminLang());
}
