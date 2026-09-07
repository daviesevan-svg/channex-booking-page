// The root registers loader-provided labels before <Meta> or child routes
// render. Keep this registry free of dictionaries and admin UI imports so
// guest pages do not download the English admin fallback just to register null.
const dictionaries = new Map<string, Record<string, string>>();

export function registerAdminDict(lang: string, dict: Record<string, string> | null | undefined): void {
  if (!dict || !lang || lang === "en") return;
  dictionaries.set(lang, dict);
}

export function registeredAdminDict(lang: string): Record<string, string> | undefined {
  return dictionaries.get(lang);
}
