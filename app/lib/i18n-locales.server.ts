// Every guest language, on the server only.
//
// The `.server` suffix is doing real work here: this module statically imports
// all eight dictionaries, and if the browser bundle could reach it we would be
// straight back to shipping 46 kB gzipped of languages nobody on the page reads.
// Nothing outside a loader may import this.
//
// The server needs them all, synchronously, because any request can be in any
// language and SSR has no chance to await a chunk mid-render. Registering at
// module load is free: this is one server bundle, already in memory.

import { registerDict, type Dict } from "./i18n";
import de from "./locales/de";
import el from "./locales/el";
import en from "./locales/en";
import es from "./locales/es";
import fr from "./locales/fr";
import it from "./locales/it";
import nl from "./locales/nl";
import pt from "./locales/pt";

const ALL: Record<string, Dict> = { en, fr, de, es, it, pt, nl, el };

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
