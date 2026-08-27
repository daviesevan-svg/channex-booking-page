import type { Route } from "./+types/api.v1.manage.property.content";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import { getOverrides, getOverridesRaw, getSettings } from "~/lib/overrides.server";

// GET /v1/manage/property/content?lang=xx — per-language property text.
//
// Returns BOTH what is stored for that language (`values` — what a write
// would edit) and what a guest reading it actually sees (`effective` — merged
// over the default language). An agent translating needs the first; an agent
// answering "what does the German page say" needs the second.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);
  const lang = (url.searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  const settings = await getSettings(auth.pid);
  const languages = settings.languages ?? [DEFAULT_LANG];
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  const [values, effective] = await Promise.all([getOverridesRaw(auth.pid, lang), getOverrides(auth.pid, lang)]);
  return Response.json({ data: { lang, languages, values, effective } });
}
