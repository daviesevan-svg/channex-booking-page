import { env, waitUntil } from "cloudflare:workers";

import type { Route } from "./+types/image";
import { getImagesBucket } from "~/lib/config.server";
import { IMAGE_WIDTHS } from "~/lib/image-srcset";

// Public resource route: serves an uploaded image from R2 at /images/<key>.
//
// `?w=<width>` returns it resized, via Cloudflare Images. Uploads are stored as
// the hotel sent them — up to the 8 MB cap — so without this a phone photo was
// downloaded in full to fill a 300px card.
//
// Two cost controls, because a transformation is billed:
//
//  * `w` must be one of `IMAGE_WIDTHS` exactly. An open parameter would let
//    anyone walk 1..2048 and run up the bill, with a cache entry each.
//  * Results go in the Worker cache, keyed by the request URL. Keys contain a
//    uuid and never change content, so a hit is always safe and a given
//    (image, width) is transformed once rather than once per visitor.

/** Formats where resizing would destroy the point of the file. */
const NO_RESIZE = new Set(["image/svg+xml", "image/gif"]);

const headersFor = (contentType: string, etag?: string, state = "original"): HeadersInit => ({
  "Content-Type": contentType,
  // Observable so the cost control can be checked rather than assumed: a
  // resized variant should be "miss" once and "hit" thereafter.
  "X-Image-Transform": state,
  "Cache-Control": "public, max-age=31536000, immutable",
  ...(etag ? { ETag: etag } : {}),
  // Uploads are admin-supplied and served same-origin, so treat them as
  // untrusted documents: `sandbox` strips scripts (an SVG can embed <script>,
  // which would otherwise run when the /images/… URL is opened directly —
  // stored XSS against logged-in admins) and nosniff stops a spoofed content
  // type being sniffed into something executable. <img> rendering is unaffected.
  "Content-Security-Policy": "sandbox",
  "X-Content-Type-Options": "nosniff",
});

export async function loader({ params, request }: Route.LoaderArgs) {
  const key = params["*"];
  const bucket = getImagesBucket();
  if (!bucket || !key) throw new Response("Not found", { status: 404 });

  const asked = Number(new URL(request.url).searchParams.get("w"));
  const width = IMAGE_WIDTHS.includes(asked as (typeof IMAGE_WIDTHS)[number]) ? asked : 0;

  // Only the resized variants are worth caching in the Worker; the original is a
  // straight R2 read, which is already cheap and CDN-cacheable on its own.
  const cache = width ? await caches.open("images").catch(() => null) : null;
  if (cache) {
    const hit = await cache.match(request).catch(() => null);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("X-Image-Transform", "hit");
      return new Response(hit.body, { headers });
    }
  }

  const object = await bucket.get(key);
  if (!object) throw new Response("Not found", { status: 404 });
  const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";

  const transformer = (env as unknown as { IMAGE_TRANSFORM?: ImagesBinding }).IMAGE_TRANSFORM;
  const resizable =
    width > 0 && transformer && contentType.startsWith("image/") && !NO_RESIZE.has(contentType);

  if (!resizable) {
    return new Response(object.body, { headers: headersFor(contentType, object.httpEtag) });
  }

  try {
    const out = await transformer
      // `fit: "scale-down"` never enlarges, so asking for a width above the
      // original returns the original size rather than a blurry upscale.
      .input(object.body)
      .transform({ width, fit: "scale-down" })
      // WebP everywhere rather than negotiating AVIF off `Accept`: that would
      // need `Vary: Accept`, and Accept strings vary enough between browsers to
      // shred the cache hit rate for a few percent of bytes.
      .output({ format: "image/webp", quality: 82 })
      .then((r) => r.response());

    const response = new Response(out.body, { headers: headersFor("image/webp", undefined, "miss") });
    if (cache) {
      // waitUntil, not a floating promise: the request context is torn down as
      // soon as the response is returned, which aborts a bare `cache.put` and
      // leaves every visit re-transforming. That was measurably the case — the
      // X-Image-Transform header above said "miss" every time.
      waitUntil(cache.put(request, response.clone()).catch(() => {}));
    }
    return response;
  } catch {
    // Transformation is an optimisation. If Images is unavailable, over quota, or
    // rejects the file, serving the original is the right answer — a broken
    // picture is not.
    const original = await bucket.get(key);
    if (!original) throw new Response("Not found", { status: 404 });
    return new Response(original.body, { headers: headersFor(contentType, original.httpEtag) });
  }
}
