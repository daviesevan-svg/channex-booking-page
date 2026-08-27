import type { Route } from "./+types/api.v1.manage.property.content";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import { validateContentPatch, validationError } from "~/lib/manage-validate";
import { getOverrides, getOverridesRaw, getSettings, saveOverrides } from "~/lib/overrides.server";
import { renameProperty } from "~/lib/properties.server";

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

// PATCH ?lang=xx — sparse edit of ONE language's stored text. Omitted fields
// stay, null clears (falls back to the default language). Editing the default
// language's hotel_name also renames the property in the registry, exactly as
// the admin editor does.
export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH.");
  const url = new URL(request.url);
  const lang = (url.searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const parsed = validateContentPatch(body);
  if (!parsed.ok) return validationError(parsed.errors);
  if (lang === DEFAULT_LANG && parsed.value.hotelName === null) {
    return validationError({ hotel_name: ["Cannot be cleared in the default language — it is what every other language falls back to."] });
  }

  // saveOverrides replaces the language's whole entry, so merge the stored
  // values with the patch first (the sparse contract lives here).
  const current = await getOverridesRaw(auth.pid, lang);
  const merged: Record<string, string> = { ...(current as Record<string, string>) };
  for (const [k, v] of Object.entries(parsed.value)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  await saveOverrides(auth.pid, lang, merged);
  if (lang === DEFAULT_LANG && typeof parsed.value.hotelName === "string") {
    await renameProperty(auth.pid, parsed.value.hotelName);
  }

  const settings = await getSettings(auth.pid);
  const [values, effective] = await Promise.all([getOverridesRaw(auth.pid, lang), getOverrides(auth.pid, lang)]);
  return Response.json({ data: { lang, languages: settings.languages ?? [DEFAULT_LANG], values, effective } });
}
