// Public merged Google Hotel List Feed: Channex's partner feed + our properties.
// Registered at /feeds/google-hotels-all.xml. Point Google at this URL to
// discover both. Resource route: a loader returning a Response, no component.
import { buildMergedGoogleFeed } from "~/lib/google-merged-feed.server";

export async function loader() {
  try {
    const xml = await buildMergedGoogleFeed();
    return new Response(xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        // Google pulls on a schedule; cache the (large) merged feed at the edge.
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e) {
    // Don't serve a partial feed (missing Channex's properties would break their
    // coverage). Fail so Google keeps its last successful pull.
    return new Response(`Feed temporarily unavailable: ${e instanceof Error ? e.message : "error"}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
