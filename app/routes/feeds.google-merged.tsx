// Public merged Google Hotel List Feed: Channex's partner feed + our properties.
// Registered at /feeds/google-hotels-all.xml. Point Google at this URL.
//
// Serves a stored snapshot (rebuilt ~daily by the cron in workers/app.ts) rather
// than proxying Channex's 14MB feed on every request. If no snapshot exists yet
// (first run), builds one live and stores it. If the live build also fails,
// returns 502 so Google keeps its last successful pull.
import {
  buildMergedGoogleFeed,
  getSavedMergedGoogleFeed,
  saveMergedGoogleFeed,
} from "~/lib/google-merged-feed.server";

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
  const saved = await getSavedMergedGoogleFeed();
  if (saved) return xml(saved.xml, saved.builtAt);

  // No snapshot yet — build once, store for next time, serve.
  try {
    const body = await buildMergedGoogleFeed();
    await saveMergedGoogleFeed(body).catch(() => {}); // best-effort (no-op without R2)
    return xml(body);
  } catch (e) {
    return new Response(`Feed temporarily unavailable: ${e instanceof Error ? e.message : "error"}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
