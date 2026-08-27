import type { Route } from "./+types/api.v1.manage.gallery";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import { MAX_GALLERY_IMAGES } from "~/lib/gallery";
import { getGallery, setGalleryImages } from "~/lib/gallery.server";
import { queueImageCleanup } from "~/lib/image-gc.server";

const langOf = (request: Request) => (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();

// GET /v1/manage/gallery?lang= — ordered images + that language's stored
//     alt/caption (no fallback — what a write edits).
// PUT — replace the image list in ONE write (order = display order). Entries
//     with a known id keep the image and every language's text; url-only
//     entries are new; missing stored images are removed and GC'd.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const lang = langOf(request);
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  const gallery = await getGallery(auth.pid);
  const text = gallery.text[lang] ?? {};
  return Response.json({
    data: {
      lang,
      max_images: MAX_GALLERY_IMAGES,
      images: gallery.images.map((i) => ({ id: i.id, url: i.url, alt: text[i.id]?.alt ?? null, caption: text[i.id]?.caption ?? null })),
    },
  });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PUT") return apiError(405, "method_not_allowed", "Use PUT with the full image list.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const list = Array.isArray(body) ? body : (body as { images?: unknown })?.images;
  if (!Array.isArray(list)) return apiError(422, "validation_error", "Send a JSON array of { id?, url } (or { images: [...] }).");
  if (list.length > MAX_GALLERY_IMAGES) return apiError(422, "validation_error", `At most ${MAX_GALLERY_IMAGES} gallery images.`);
  const items: { id?: string; url: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i] as { id?: unknown; url?: unknown };
    if (!item || typeof item !== "object" || typeof item.url !== "string" || !item.url.startsWith("/images/")) {
      return apiError(422, "validation_error", `[${i}] needs a url that is an /images/… path (upload via POST /v1/manage/images).`);
    }
    items.push({ id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined, url: item.url });
  }
  const { removedUrls } = await setGalleryImages(auth.pid, items);
  queueImageCleanup(auth.pid, removedUrls);
  const gallery = await getGallery(auth.pid);
  return Response.json({ data: { images: gallery.images } });
}
