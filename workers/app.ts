import { createRequestHandler } from "react-router";

import { scheduledGoogleAriSync } from "../app/lib/google-ari/push.server";
import { refreshMergedGoogleFeed } from "../app/lib/google-merged-feed.server";
import { refreshMergedVrFeed } from "../app/lib/google-merged-vr-feed.server";
import { scheduledReviewRequests } from "../app/lib/review-requests.server";
import { refreshAllMatchStatuses } from "../app/lib/google-ari/status.server";
import { pruneAri } from "../app/lib/ari/admin.server";
import { pruneSearchEvents } from "../app/lib/search-analytics.server";
import { pruneFunnelEvents } from "../app/lib/funnel-analytics.server";
import { pruneCollectionEvents } from "../app/lib/collection-analytics.server";
import { activateVerifiedDomains } from "../app/lib/custom-hostnames.server";
import { getConfig } from "../app/lib/config.server";


const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/**
 * Send the CNAME target's own hostname to the canonical one.
 *
 * `customers.roompanda.com` exists for hotels to point a CNAME at. Because the
 * wildcard Worker route catches every hostname on the zone, visiting it directly
 * used to serve the full guest picker and the admin login — a working duplicate
 * of book.roompanda.com that search engines can index.
 *
 * Custom-hostname traffic is unaffected: a request for a hotel's domain keeps
 * that hostname all the way through (the Worker runs before origin resolution),
 * so it never appears here as the CNAME target.
 *
 * Never throws — this is on every request, and a malformed APP_URL must degrade
 * to "no redirect" rather than 500 the whole site.
 */
function canonicalRedirect(request: Request): Response | null {
  try {
    const { customHostnameTarget, appUrl } = getConfig();
    if (!customHostnameTarget) return null;
    const url = new URL(request.url);
    if (url.hostname.toLowerCase() !== customHostnameTarget.trim().toLowerCase()) return null;
    const to = new URL(url.pathname + url.search, appUrl);
    // Don't bounce to ourselves if APP_URL somehow names this same host.
    if (to.hostname.toLowerCase() === url.hostname.toLowerCase()) return null;
    return Response.redirect(to.toString(), 301);
  } catch {
    return null;
  }
}

export default {
  async fetch(request) {
    return canonicalRedirect(request) ?? requestHandler(request);
  },
  // Cron (see wrangler.jsonc `triggers.crons`): (1) keep Google's ARI in sync by
  // re-pushing every ARI-enabled property — a backstop to the change-driven and
  // admin-edit pushes; (2) rebuild the merged Google feed snapshot. The feed
  // rebuild self-throttles to ~once a day (skips if the stored copy is fresh)
  // and keeps the previous snapshot if Channex can't be reached; (3) prune ARI
  // rows outside the useful window (past dates + >730 days out) so D1 stays
  // bounded.
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(scheduledGoogleAriSync());
    ctx.waitUntil(refreshMergedGoogleFeed());
    ctx.waitUntil(refreshMergedVrFeed());
    ctx.waitUntil(pruneAri().catch((e) => console.log(`[cron] pruneAri failed: ${e}`)));
    // Search-demand events beyond the longest dashboard window get dropped too.
    ctx.waitUntil(pruneSearchEvents().catch((e) => console.log(`[cron] pruneSearchEvents failed: ${e}`)));
    // Booking-funnel events: 3-month retention keeps the table small by design.
    ctx.waitUntil(pruneFunnelEvents().catch((e) => console.log(`[cron] pruneFunnelEvents failed: ${e}`)));
    // Collection landing-page engagement events beyond the window get dropped too.
    ctx.waitUntil(pruneCollectionEvents().catch((e) => console.log(`[cron] pruneCollectionEvents failed: ${e}`)));
    // Refresh the Google match status ~daily (self-throttled) so the admin page
    // reads it from KV instead of calling the slow Travel Partner API on load.
    ctx.waitUntil(refreshAllMatchStatuses().catch((e) => console.log(`[cron] refreshAllMatchStatuses failed: ${e}`)));
    // Review requests: checkout-evening ask + up to two reminders per booking.
    ctx.waitUntil(scheduledReviewRequests().catch((e) => console.log(`[cron] scheduledReviewRequests failed: ${e}`)));
    // Custom domains: switch on any hostname Cloudflare has since verified. The
    // admin has a button for this, but hotels add their DNS records and don't come
    // back — without the sweep the domain would sit dark with everything in place.
    ctx.waitUntil(activateVerifiedDomains().catch((e) => console.log(`[cron] activateVerifiedDomains failed: ${e}`)));
  },
} satisfies ExportedHandler<Env>;
