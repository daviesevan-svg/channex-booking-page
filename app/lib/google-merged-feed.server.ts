// Merged Google list feeds: Channex's partner feed, with our properties added.
// Google can be pointed at one URL to discover both Channex's listings and ours.
// Used for both Hotels (this file's wrappers) and Vacation Rentals
// (google-merged-vr-feed.server.ts) — the splice + snapshot logic is generic.
//
// Contract: we pass Channex's feed through untouched — EXCEPT one mechanical
// schema repair (normalizeRelations below) — and splice our <listing> blocks in
// immediately before the closing </listings> tag, so nothing of theirs is
// reparsed. Our listings come from the same generators as our own feeds, so
// they conform to the Google local_feed.xsd (incomplete properties are already
// filtered out) and can't invalidate the document.
import { googleListingElements } from "./hotel-list-feed.server";
import { getImagesBucket } from "./config.server";

// Channex's Google Hotel ARI partner feed.
const CHANNEX_FEED_URL =
  "https://app.channex.io/api/v1/meta/googlehotelari/list?partner_account=channex_ari";

const CLOSE_TAG = "</listings>";

/** Repair Channex's <relation> blocks to satisfy Google's local_feed.xsd: the
 *  schema requires <parent_id> BEFORE <relation_type>, but Channex's generator
 *  emits them the other way round — Google's validator rejects the feed with
 *  cvc-complex-type.2.4.a on every listing that carries a relation. A purely
 *  mechanical swap (content untouched) keeps the merged feed schema-valid until
 *  the generator is fixed at the source; already-ordered blocks don't match and
 *  pass through unchanged. */
export function normalizeRelations(xml: string): string {
  return xml.replace(
    /<relation>(\s*)<relation_type>([^<]*)<\/relation_type>(\s*)<parent_id>([^<]*)<\/parent_id>(\s*)<\/relation>/g,
    "<relation>$1<parent_id>$4</parent_id>$3<relation_type>$2</relation_type>$5</relation>",
  );
}

/** Fetch a Channex list feed and return it with our listings appended. Throws if
 *  the Channex feed can't be fetched or doesn't look like the expected document
 *  — the caller should then serve an error, NOT a partial feed, so Google keeps
 *  its last good copy (dropping Channex's properties would break their feed). */
export async function spliceListingsFeed(
  channexFeedUrl: string,
  ourListingElements: () => Promise<string>,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(channexFeedUrl, { headers: { Accept: "application/xml" } });
  } catch {
    throw new Error("Could not reach the Channex feed.");
  }
  if (!res.ok) throw new Error(`Channex feed returned ${res.status}.`);
  const channex = normalizeRelations(await res.text());

  // Guard: only splice into a document that really is the listings feed.
  const close = channex.lastIndexOf(CLOSE_TAG);
  if (close === -1 || !channex.includes("<listings")) {
    throw new Error("Unexpected Channex feed shape.");
  }

  const ours = await ourListingElements();
  if (!ours.trim()) return channex; // nothing of ours to add — return theirs untouched

  return `${channex.slice(0, close)}\n${ours}\n${channex.slice(close)}`;
}

/** Fetch Channex's hotel feed and return it with our hotel listings appended. */
export async function buildMergedGoogleFeed(): Promise<string> {
  return spliceListingsFeed(CHANNEX_FEED_URL, googleListingElements);
}

// ── Stored snapshot ──────────────────────────────────────────────────────────
// These feeds are large (~14MB for hotels) and Channex's side changes slowly, so
// we don't rebuild per request. A scheduled job builds each ~once a day and
// stores it in R2; the route serves that snapshot. If a rebuild can't fetch
// Channex we keep the previous snapshot, so Google always gets the last good feed.

const HOTELS_FEED_KEY = "feeds/google-hotels-all.xml";
// Rebuild at most this often — the cron ticks more frequently, so this makes it
// effectively daily without needing a dedicated cron expression.
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;

export interface SavedFeed {
  xml: string;
  builtAt: number;
}

/** The stored snapshot for a feed key, or null if none saved / no R2 configured. */
export async function getSavedFeed(feedKey: string): Promise<SavedFeed | null> {
  const bucket = getImagesBucket();
  if (!bucket) return null;
  const obj = await bucket.get(feedKey);
  if (!obj) return null;
  return { xml: await obj.text(), builtAt: Number(obj.customMetadata?.builtAt) || 0 };
}

async function save(feedKey: string, xml: string, at: number): Promise<void> {
  const bucket = getImagesBucket();
  if (!bucket) return;
  await bucket.put(feedKey, xml, {
    httpMetadata: { contentType: "application/xml; charset=utf-8" },
    customMetadata: { builtAt: String(at) },
  });
}

/** Persist a freshly-built feed under a key (used by the route's lazy first build). */
export async function saveFeedSnapshot(feedKey: string, xml: string): Promise<void> {
  await save(feedKey, xml, Date.now());
}

/** Rebuild + store a snapshot. Skips if the current one is still fresh (unless
 *  forced). On a build/fetch error the existing snapshot is left untouched —
 *  Google keeps getting the last good feed. Safe to call every cron tick;
 *  self-throttles to ~daily. */
export async function refreshFeedSnapshot(
  feedKey: string,
  build: () => Promise<string>,
  force = false,
): Promise<{ ok: boolean; skipped?: boolean }> {
  const bucket = getImagesBucket();
  if (!bucket) return { ok: false };
  if (!force) {
    const head = await bucket.head(feedKey);
    const builtAt = Number(head?.customMetadata?.builtAt) || 0;
    if (builtAt && Date.now() - builtAt < REFRESH_AFTER_MS) return { ok: true, skipped: true };
  }
  let xml: string;
  try {
    xml = await build();
  } catch (e) {
    console.log(`[google-feed] rebuild failed for ${feedKey}, keeping previous snapshot: ${e instanceof Error ? e.message : e}`);
    return { ok: false };
  }
  await save(feedKey, xml, Date.now());
  return { ok: true };
}

// ── Hotels wrappers (bound to the hotels feed key) ───────────────────────────
export const getSavedMergedGoogleFeed = () => getSavedFeed(HOTELS_FEED_KEY);
export const saveMergedGoogleFeed = (xml: string) => saveFeedSnapshot(HOTELS_FEED_KEY, xml);
export const refreshMergedGoogleFeed = (force = false) =>
  refreshFeedSnapshot(HOTELS_FEED_KEY, buildMergedGoogleFeed, force);
