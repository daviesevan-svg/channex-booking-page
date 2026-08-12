// Every admin language, on the server only.
//
// The `.server` suffix is doing real work here: this module statically imports
// all five non-English dictionaries, and if the browser bundle could reach it
// we would be straight back to a 755 kB chunk of languages the signed-in admin
// cannot read, loaded by every admin page. Nothing outside a loader may import
// this. Same contract as i18n-locales.server.ts on the guest side.
//
// The server needs them all, synchronously, because any request can be in any
// language and SSR has no chance to await a chunk mid-render. Registering at
// module load is free: this is one server bundle, already in memory.

import { registerAdminDict } from "./admin-i18n";
import de from "./admin-locales/de";
import el from "./admin-locales/el";
import pt from "./admin-locales/pt";
import th from "./admin-locales/th";
import tr from "./admin-locales/tr";

const ALL: Record<string, Record<string, string>> = { de, pt, el, th, tr };

for (const [lang, dict] of Object.entries(ALL)) registerAdminDict(lang, dict);

/**
 * The labels to hand the browser for `lang`, or null when it needs none.
 *
 * English is already in the client bundle as the default and the per-key
 * fallback, so sending it again would be pure waste — hence the null.
 */
export function adminDictFor(lang: string): Record<string, string> | null {
  if (!lang || lang === "en") return null;
  return ALL[lang] ?? null;
}
