// Guest UI labels (not admin-editable). Editable copy lives in content.ts.
//
// Only ENGLISH is bundled for the browser. It has to be — it's the default and
// the per-key fallback — but the other eight were shipping too, 46 kB gzipped of
// languages a given visitor cannot read. They now live in ./locales/*, are
// imported on the server only (i18n-locales.server.ts), and the active one
// reaches the browser as root loader data, registered by root's Layout before
// anything renders. See `registerDict`.

import { enGB, type Locale } from "date-fns/locale";

import EN from "./locales/en";
import { DATE_LOCALES } from "./locales/date-locales";
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

/** Which plural form a count takes. 1 is always `_one` and every other count
 *  that CLDR also calls "one" (French 0, Russian 21) stays `_other`, which is
 *  what every dictionary was written against. Languages with more forms add
 *  keys for them — Slovak/Czech `_few` (2–4) — and fall back to `_other` when
 *  a key has none. scripts/i18n.mjs mirrors this to decide which rows to export. */
const PLURAL_RULES = new Map<string, Intl.PluralRules | null>();
export function pluralForm(lang: string, n: number): string {
  if (n === 1) return "one";
  if (!PLURAL_RULES.has(lang)) {
    let rules: Intl.PluralRules | null = null;
    try {
      rules = new Intl.PluralRules(lang);
    } catch {
      // unknown tag: English rules
    }
    PLURAL_RULES.set(lang, rules);
  }
  const cat = PLURAL_RULES.get(lang)?.select(n) ?? "other";
  return cat === "one" ? "other" : cat;
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : s;
}

export interface Translator {
  lang: string;
  locale: Locale;
  /** Translate a key with optional {var} interpolation. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Pluralized key: picks `${key}_one` / `_few` / … / `_other` (see pluralForm) and fills {n}. */
  p: (key: string, n: number, vars?: Record<string, string | number>) => string;
}

export function makeTranslator(lang: string): Translator {
  const dict = DICTS.get(lang) ?? EN;
  const t = (key: string, vars?: Record<string, string | number>) =>
    interpolate(dict[key] ?? EN[key] ?? key, vars);
  const p = (key: string, n: number, vars?: Record<string, string | number>) => {
    const form = pluralForm(lang, n);
    const k = `${key}_${form}`;
    const other = `${key}_${form === "one" ? "one" : "other"}`;
    return interpolate(dict[k] ?? dict[other] ?? EN[other] ?? key, { ...vars, n });
  };
  return { lang, locale: DATE_LOCALES[lang] ?? enGB, t, p };
}

/** Localized "{n} adults[, {m} children]" label. */
export function occLabel(tr: Translator, adults: number, childrenAge: number[]): string {
  return tr.p("adult", adults) + (childrenAge.length ? `, ${tr.p("child", childrenAge.length)}` : "");
}

/** Translator bound to the current guest language (from the property layout). */
export function useT(): Translator {
  return makeTranslator(useProperty().lang);
}
