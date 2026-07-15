// The merged Google Vacation Rentals list feed as a ZIP — Google requires the
// feed URL it pulls to be a .zip. Registered at
// /feeds/google-vacation-rentals-all.zip. Zips the stored snapshot on demand
// (Google pulls ~daily, and deflate of the ~13MB document is native + fast);
// same lazy-first-build/502 contract as the XML route (feeds.google-merged-vr).
import {
  buildMergedVrFeed,
  getSavedMergedVrFeed,
  saveMergedVrFeed,
} from "~/lib/google-merged-vr-feed.server";
import { zipSingleFile } from "~/lib/zip.server";

export async function loader() {
  const saved = await getSavedMergedVrFeed();
  let xml = saved?.xml;
  let builtAt = saved?.builtAt;
  if (!xml) {
    // No snapshot yet — build once, store for next time, serve.
    try {
      xml = await buildMergedVrFeed();
      await saveMergedVrFeed(xml).catch(() => {}); // best-effort (no-op without R2)
      builtAt = Date.now();
    } catch (e) {
      return new Response(`Feed temporarily unavailable: ${e instanceof Error ? e.message : "error"}`, {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  }

  const zip = await zipSingleFile("google-vacation-rentals-all.xml", new TextEncoder().encode(xml));
  return new Response(zip as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="google-vacation-rentals-all.zip"',
      "Cache-Control": "public, max-age=3600",
      ...(builtAt ? { "Last-Modified": new Date(builtAt).toUTCString() } : {}),
    },
  });
}
