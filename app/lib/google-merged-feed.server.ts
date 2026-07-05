// Merged Google Hotel List Feed: Channex's partner feed, with our properties
// added. Google can be pointed at this one URL to discover both Channex's
// listings and ours.
//
// Contract: we DO NOT touch Channex's feed. Their XML is passed through
// byte-for-byte and our <listing> blocks are spliced in immediately before the
// closing </listings> tag, so nothing of theirs is reparsed or altered. Our
// listings come from the same generator as our own feed, so they conform to the
// Google local_feed.xsd (incomplete properties are already filtered out) and
// can't invalidate the document.
import { googleListingElements } from "./hotel-list-feed.server";
import { getImagesBucket } from "./config.server";

// Channex's Google Hotel ARI partner feed.
const CHANNEX_FEED_URL =
  "https://app.channex.io/api/v1/meta/googlehotelari/list?partner_account=channex_ari";

const CLOSE_TAG = "</listings>";

/** Fetch Channex's feed and return it with our listings appended. Throws if the
 *  Channex feed can't be fetched or doesn't look like the expected document —
 *  the caller should then serve an error, NOT a partial feed, so Google keeps
 *  its last good copy (dropping Channex's properties would break their feed). */
export async function buildMergedGoogleFeed(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(CHANNEX_FEED_URL, { headers: { Accept: "application/xml" } });
  } catch {
    throw new Error("Could not reach the Channex feed.");
  }
  if (!res.ok) throw new Error(`Channex feed returned ${res.status}.`);
  const channex = await res.text();

  // Guard: only splice into a document that really is the listings feed.
  const close = channex.lastIndexOf(CLOSE_TAG);
  if (close === -1 || !channex.includes("<listings")) {
    throw new Error("Unexpected Channex feed shape.");
  }

  const ours = await googleListingElements();
  if (!ours.trim()) return channex; // nothing of ours to add — return theirs untouched

  return `${channex.slice(0, close)}\n${ours}\n${channex.slice(close)}`;
}

// ── Stored snapshot ──────────────────────────────────────────────────────────
// The feed is ~14MB and Channex's side changes slowly, so we don't rebuild it
// per request. Instead a scheduled job builds it ~once a day and stores it in
// R2; the route serves that snapshot. If a rebuild can't fetch Channex we keep
// the previous snapshot, so Google always gets the last good feed.

const FEED_KEY = "feeds/google-hotels-all.xml";
// Rebuild at most this often — the cron ticks more frequently, so this makes it
// effectively daily without needing a dedicated cron expression.
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;

export interface SavedFeed {
  xml: string;
  builtAt: number;
}

/** The stored snapshot, or null if none saved / no R2 configured. */
export async function getSavedMergedGoogleFeed(): Promise<SavedFeed | null> {
  const bucket = getImagesBucket();
  if (!bucket) return null;
  const obj = await bucket.get(FEED_KEY);
  if (!obj) return null;
  return { xml: await obj.text(), builtAt: Number(obj.customMetadata?.builtAt) || 0 };
}

async function save(xml: string, at: number): Promise<void> {
  const bucket = getImagesBucket();
  if (!bucket) return;
  await bucket.put(FEED_KEY, xml, {
    httpMetadata: { contentType: "application/xml; charset=utf-8" },
    customMetadata: { builtAt: String(at) },
  });
}

/** Persist a freshly-built feed (used by the route's lazy first build). */
export async function saveMergedGoogleFeed(xml: string): Promise<void> {
  await save(xml, Date.now());
}

/** Rebuild + store the snapshot. Skips if the current one is still fresh
 *  (unless forced). On a build/fetch error the existing snapshot is left
 *  untouched — Google keeps getting the last good feed. Safe to call every
 *  cron tick; self-throttles to ~daily. */
export async function refreshMergedGoogleFeed(force = false): Promise<{ ok: boolean; skipped?: boolean }> {
  const bucket = getImagesBucket();
  if (!bucket) return { ok: false };
  if (!force) {
    const head = await bucket.head(FEED_KEY);
    const builtAt = Number(head?.customMetadata?.builtAt) || 0;
    if (builtAt && Date.now() - builtAt < REFRESH_AFTER_MS) return { ok: true, skipped: true };
  }
  let xml: string;
  try {
    xml = await buildMergedGoogleFeed();
  } catch (e) {
    console.log(`[google-feed] rebuild failed, keeping previous snapshot: ${e instanceof Error ? e.message : e}`);
    return { ok: false };
  }
  await save(xml, Date.now());
  return { ok: true };
}
