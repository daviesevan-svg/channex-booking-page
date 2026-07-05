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
