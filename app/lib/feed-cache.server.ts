// Edge cache for the Google feeds we build per request.
//
// A Worker response's own Cache-Control is not honoured by Cloudflare's CDN
// (it only caches what the Cache API is told to), so before this every pull of
// /feeds/google-hotels.xml rebuilt the feed from ~100 properties' KV and D1
// records: ~4 s warm, ~40 s on a cold isolate. Google pulls these on a
// schedule; an hour-old copy is as good as a fresh one.
//
// Keyed on origin + path only, so a query string can't force a rebuild. Per
// Cloudflare data centre, like every Cache API entry. Best-effort throughout:
// no cache (local dev, tests) or a cache error just builds the feed.
import { waitUntil } from "cloudflare:workers";

export const FEED_CACHE_SECONDS = 3600;

export async function cachedFeed(request: Request, build: () => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const key = new Request(`${url.origin}${url.pathname}`);
  const cache = typeof caches === "undefined" ? null : await caches.open("feeds").catch(() => null);
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("X-Feed-Cache", "hit");
      return new Response(hit.body, { status: hit.status, headers });
    }
  }
  const res = await build();
  // Only a good feed is cached; an error must not be pinned for an hour.
  if (cache && res.ok) {
    // waitUntil, not a bare put: the isolate may be torn down as soon as the
    // response is returned, which aborts an unawaited write.
    waitUntil(cache.put(key, res.clone()).catch(() => {}));
  }
  const headers = new Headers(res.headers);
  headers.set("X-Feed-Cache", "miss");
  return new Response(res.body, { status: res.status, headers });
}
