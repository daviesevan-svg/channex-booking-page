import type { Route } from "./+types/api.v1.manage.content.search";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG, type SearchContent } from "~/lib/content";
import { getHeroImage, getSearchContent, getSearchContentRaw, saveHeroImage, saveSearchContent } from "~/lib/overrides.server";

const FIELDS = ["eyebrow", "heading", "intro", "promo_text", "promo_placeholder", "search_button", "highlights", "hero_image"] as const;
const TO_CAMEL: Record<string, keyof SearchContent> = {
  eyebrow: "eyebrow", heading: "heading", intro: "intro",
  promo_text: "promoText", promo_placeholder: "promoPlaceholder", search_button: "searchButton",
};

const view = (raw: SearchContent, effective: SearchContent, heroImage: string | undefined, lang: string) => ({
  lang,
  values: {
    eyebrow: raw.eyebrow ?? null, heading: raw.heading ?? null, intro: raw.intro ?? null,
    promo_text: raw.promoText ?? null, promo_placeholder: raw.promoPlaceholder ?? null,
    search_button: raw.searchButton ?? null, highlights: raw.highlights ?? null,
  },
  effective: {
    eyebrow: effective.eyebrow ?? null, heading: effective.heading ?? null, intro: effective.intro ?? null,
    promo_text: effective.promoText ?? null, promo_placeholder: effective.promoPlaceholder ?? null,
    search_button: effective.searchButton ?? null, highlights: effective.highlights ?? [],
  },
  hero_image: heroImage ?? null,
});

// GET   /v1/manage/content/search?lang= — the search/hero block: stored values
//       for that language + the effective (fallback-resolved) view.
// PATCH — sparse per language; null clears. `hero_image` is language-
//       independent (it rides the default-language entry) and only accepted
//       without a lang override.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  const [raw, effective, hero] = await Promise.all([getSearchContentRaw(auth.pid, lang), getSearchContent(auth.pid, lang), getHeroImage(auth.pid)]);
  return Response.json({ data: view(raw, effective, hero, lang) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH.");
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(422, "validation_error", "Body must be a JSON object.");
  for (const k of Object.keys(body)) {
    if (!(FIELDS as readonly string[]).includes(k)) return apiError(422, "validation_error", `Unknown field "${k}".`);
  }

  const merged: SearchContent = { ...(await getSearchContentRaw(auth.pid, lang)) };
  for (const [wire, camel] of Object.entries(TO_CAMEL)) {
    const v = body[wire];
    if (v === undefined) continue;
    if (v === null) delete merged[camel];
    else if (typeof v !== "string") return apiError(422, "validation_error", `\`${wire}\` must be a string or null.`);
    else (merged as Record<string, unknown>)[camel] = v.trim() || undefined;
  }
  if (body.highlights !== undefined) {
    if (body.highlights === null) delete merged.highlights;
    else if (
      !Array.isArray(body.highlights) ||
      body.highlights.some((h) => !h || typeof h !== "object" || typeof (h as { title?: unknown }).title !== "string" || typeof (h as { description?: unknown }).description !== "string")
    ) {
      return apiError(422, "validation_error", "`highlights` must be an array of { title, description } (or null).");
    } else merged.highlights = (body.highlights as { title: string; description: string }[]).map((h) => ({ title: h.title.trim(), description: h.description.trim() }));
  }
  await saveSearchContent(auth.pid, lang, merged);

  if (body.hero_image !== undefined) {
    if (lang !== DEFAULT_LANG) return apiError(422, "validation_error", "`hero_image` is language-independent — set it without a lang override.");
    if (body.hero_image !== null && (typeof body.hero_image !== "string" || !body.hero_image.startsWith("/images/"))) {
      return apiError(422, "validation_error", "`hero_image` must be an /images/… path (upload via POST /v1/manage/images) or null.");
    }
    await saveHeroImage(auth.pid, (body.hero_image as string | null) ?? null);
  }

  const [raw, effective, hero] = await Promise.all([getSearchContentRaw(auth.pid, lang), getSearchContent(auth.pid, lang), getHeroImage(auth.pid)]);
  return Response.json({ data: view(raw, effective, hero, lang) });
}
