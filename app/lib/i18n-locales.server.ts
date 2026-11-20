// Every guest language, on the server only.
//
// The `.server` suffix is doing real work here: this module statically imports
// every dictionary, and if the browser bundle could reach it we would be
// straight back to shipping 46 kB gzipped of languages nobody on the page reads.
// Nothing outside a loader may import this.
//
// The server needs them all, synchronously, because any request can be in any
// language and SSR has no chance to await a chunk mid-render. Registering at
// module load is free: this is one server bundle, already in memory.

import { makeTranslator, registerDict, type Dict, type Translator } from "./i18n";
import { GUEST_DICTS } from "./locales/dicts.server";

// Generated from the files in app/lib/locales/ by `npm run i18n:sync`.
const ALL: Record<string, Dict> = GUEST_DICTS;

for (const [lang, dict] of Object.entries(ALL)) registerDict(lang, dict);

/**
 * The labels to hand the browser for `lang`, or null when it needs none.
 *
 * English is already in the client bundle as the default and the per-key
 * fallback, so sending it again would be pure waste — hence the null.
 */
export function guestDictFor(lang: string): Dict | null {
  if (!lang || lang === "en") return null;
  return ALL[lang] ?? null;
}

/** A server-side translator for `lang`. Importing it from here (rather than
 *  calling makeTranslator directly) guarantees every dictionary is registered
 *  first — a loader that reaches makeTranslator before this module has loaded
 *  would silently get English. */
export function serverTranslator(lang: string): Translator {
  return makeTranslator(lang);
}
