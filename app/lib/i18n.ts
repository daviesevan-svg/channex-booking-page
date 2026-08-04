// Guest UI labels (not admin-editable). Editable copy lives in content.ts.
//
// Only ENGLISH is bundled for the browser. It has to be — it's the default and
// the per-key fallback — but the other eight were shipping too, 46 kB gzipped of
// languages a given visitor cannot read. They now live in ./locales/*, are
// imported on the server only (i18n-locales.server.ts), and the active one
// reaches the browser as root loader data, registered by root's Layout before
// anything renders. See `registerDict`.

import { de, el, enGB, es, fr, it, nl, pt, th, type Locale } from "date-fns/locale";

import EN from "./locales/en";
import type { Dict } from "./i18n-dict";
import { useProperty } from "./booking-context";

export type { Dict };

/**
 * Languages available to `makeTranslator` right now.
 *
 * English is always here. On the server, i18n-locales.server.ts fills in the
 * rest at module load. In the browser only the requested language is ever added,
 * so a miss means "not this visitor's language" and English is the right answer —
 * which is exactly what the per-key fallback already did.
 */
const DICTS = new Map<string, Dict>([["en", EN]]);

/** Register one language's labels. Idempotent — called on every render of root's
 *  Layout, which is what keeps a client-side language switch working. */
export function registerDict(lang: string, dict: Dict | null | undefined): void {
  if (!dict || !lang || lang === "en") return;
  DICTS.set(lang, dict);
}

const LOCALES: Record<string, Locale> = { en: enGB, fr, de, es, it, pt, nl, el, th };

function interpolate(s: string, vars?: Record<string, string | number>): string {
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : s;
}

export interface Translator {
  lang: string;
  locale: Locale;
  /** Translate a key with optional {var} interpolation. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Pluralized key: picks `${key}_one` / `${key}_other` and fills {n}. */
  p: (key: string, n: number, vars?: Record<string, string | number>) => string;
}

export function makeTranslator(lang: string): Translator {
  const dict = DICTS.get(lang) ?? EN;
  const t = (key: string, vars?: Record<string, string | number>) =>
    interpolate(dict[key] ?? EN[key] ?? key, vars);
  const p = (key: string, n: number, vars?: Record<string, string | number>) => {
    const k = `${key}_${n === 1 ? "one" : "other"}`;
    return interpolate(dict[k] ?? EN[k] ?? key, { ...vars, n });
  };
  return { lang, locale: LOCALES[lang] ?? enGB, t, p };
}

/** Localized "{n} adults[, {m} children]" label. */
export function occLabel(tr: Translator, adults: number, childrenAge: number[]): string {
  return tr.p("adult", adults) + (childrenAge.length ? `, ${tr.p("child", childrenAge.length)}` : "");
}

/** Translator bound to the current guest language (from the property layout). */
export function useT(): Translator {
  return makeTranslator(useProperty().lang);
}
