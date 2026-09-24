// Public Google Vacation Rentals list feed, served as XML for Google's scheduled
// pull. Registered at /feeds/google-vacation-rentals.xml in routes.ts. Resource
// route: a loader returning a Response, no component.
import { buildVrListFeed } from "~/lib/vr-list-feed.server";
import { requireCanonicalHost } from "~/lib/domains.server";
import { cachedFeed, FEED_CACHE_SECONDS } from "~/lib/feed-cache.server";

export async function loader({ request }: { request: Request }) {
  // Our feed, not the hotel's — don't serve it from their domain.
  requireCanonicalHost(request);
  // Built from every property's records, so served from the edge cache for an
  // hour rather than rebuilt on each pull (feed-cache.server.ts).
  return cachedFeed(request, async () => {
    const xml = await buildVrListFeed();
    return new Response(xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": `public, max-age=${FEED_CACHE_SECONDS}`,
      },
    });
  });
}
