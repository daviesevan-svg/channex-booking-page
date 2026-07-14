// Public merged Google Vacation Rentals list feed: Channex's VR partner feed +
// our VR properties. Registered at /feeds/google-vacation-rentals-all.xml. Point
// Google at this URL. Same snapshot/lazy-build/502 contract as the merged hotels
// feed (feeds.google-merged.tsx).
import {
  buildMergedVrFeed,
  getSavedMergedVrFeed,
  saveMergedVrFeed,
} from "~/lib/google-merged-vr-feed.server";

function xml(body: string, builtAt?: number): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      ...(builtAt ? { "Last-Modified": new Date(builtAt).toUTCString() } : {}),
    },
  });
}

export async function loader() {
  // Fast path: serve the stored snapshot.
  const saved = await getSavedMergedVrFeed();
  if (saved) return xml(saved.xml, saved.builtAt);

  // No snapshot yet — build once, store for next time, serve.
  try {
    const body = await buildMergedVrFeed();
    await saveMergedVrFeed(body).catch(() => {}); // best-effort (no-op without R2)
    return xml(body);
  } catch (e) {
    return new Response(`Feed temporarily unavailable: ${e instanceof Error ? e.message : "error"}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
