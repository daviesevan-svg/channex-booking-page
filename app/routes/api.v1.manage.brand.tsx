import type { Route } from "./+types/api.v1.manage.brand";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { FONT_PAIRS, THEMES, isFontPairId, isThemeId } from "~/lib/content";
import { getSettings, patchSettings } from "~/lib/overrides.server";

const HEX = /^#?[0-9a-fA-F]{6}$/;
const norm = (v: string) => (v.startsWith("#") ? v.toLowerCase() : `#${v.toLowerCase()}`);

const view = (s: Awaited<ReturnType<typeof getSettings>>) => ({
  theme: s.theme ?? null,
  custom_color: s.customColor ?? null,
  custom_bg: s.customBg ?? null,
  font: s.themeFont ?? "default",
  themes: THEMES.map((t) => ({ id: t.id, label: t.label, accent: t.accent })),
  fonts: FONT_PAIRS.map((f) => ({ id: f.id, label: f.label })),
});

// GET   /v1/manage/brand — the theme selection + the curated vocabularies
//       (theme presets and font pairings; arbitrary fonts are never accepted —
//       nobody has loaded them).
// PATCH — sparse: theme (a preset id, "custom", or null for default),
//       custom_color/custom_bg (#rrggbb, null clears), font (a pairing id).
//       Unlike the admin form, invalid values are 422s, never silently kept.
//       One theme drives BOTH the booking pages and the embeddable widget.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  return Response.json({ data: view(await getSettings(auth.pid)) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PATCH") return apiError(405, "method_not_allowed", "Use PATCH.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(422, "validation_error", "Body must be a JSON object.");
  const patch: Parameters<typeof patchSettings>[1] = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "theme") {
      if (v === null) patch.theme = null as never;
      else if (typeof v !== "string" || (v !== "custom" && !isThemeId(v))) {
        return apiError(422, "validation_error", `theme must be one of ${THEMES.map((t) => t.id).join(", ")}, "custom", or null.`);
      } else patch.theme = v as never;
    } else if (k === "custom_color" || k === "custom_bg") {
      const field = k === "custom_color" ? "customColor" : "customBg";
      if (v === null) patch[field] = null as never;
      else if (typeof v !== "string" || !HEX.test(v.trim())) return apiError(422, "validation_error", `${k} must be a hex color like #7a4a2b, or null.`);
      else patch[field] = norm(v.trim()) as never;
    } else if (k === "font") {
      if (v === null || v === "default") patch.themeFont = null as never;
      else if (typeof v !== "string" || !isFontPairId(v)) {
        return apiError(422, "validation_error", `font must be one of ${FONT_PAIRS.map((f) => f.id).join(", ")} — arbitrary font families are never accepted.`);
      } else patch.themeFont = v;
    } else {
      return apiError(422, "validation_error", `Unknown field "${k}".`);
    }
  }
  if (Object.keys(patch).length === 0) return apiError(422, "validation_error", "No fields to update.");
  const settings = await patchSettings(auth.pid, patch);
  return Response.json({ data: view(settings) });
}
