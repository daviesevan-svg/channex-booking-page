// Merged Google Vacation Rentals list feed: Channex's VR partner feed, with our
// VR properties added. Google can be pointed at this one URL to discover both
// Channex's VR listings and ours. Same passthrough + snapshot contract as the
// merged hotels feed — see google-merged-feed.server.ts.
import {
  getSavedFeed,
  refreshFeedSnapshot,
  saveFeedSnapshot,
  spliceListingsFeed,
} from "./google-merged-feed.server";
import { vrListingElements } from "./vr-list-feed.server";

// Channex's Google Vacation Rentals partner feed (VR partner account).
const CHANNEX_VR_FEED_URL =
  "https://app.channex.io/api/v1/meta/googlehotelari/list?partner_account=channex";

const VR_FEED_KEY = "feeds/google-vacation-rentals-all.xml";

/** Fetch Channex's VR feed and return it with our VR listings appended. */
export async function buildMergedVrFeed(): Promise<string> {
  return spliceListingsFeed(CHANNEX_VR_FEED_URL, vrListingElements);
}

export const getSavedMergedVrFeed = () => getSavedFeed(VR_FEED_KEY);
export const saveMergedVrFeed = (xml: string) => saveFeedSnapshot(VR_FEED_KEY, xml);
export const refreshMergedVrFeed = (force = false) =>
  refreshFeedSnapshot(VR_FEED_KEY, buildMergedVrFeed, force);
