import { createRequestHandler } from "react-router";

import { scheduledGoogleAriSync } from "../app/lib/google-ari/push.server";
import { refreshMergedGoogleFeed } from "../app/lib/google-merged-feed.server";
import { refreshMergedVrFeed } from "../app/lib/google-merged-vr-feed.server";
import { refreshAllMatchStatuses } from "../app/lib/google-ari/status.server";
import { pruneAri } from "../app/lib/ari.server";
import { pruneSearchEvents } from "../app/lib/search-analytics.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request) {
    return requestHandler(request);
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
    // Refresh the Google match status ~daily (self-throttled) so the admin page
    // reads it from KV instead of calling the slow Travel Partner API on load.
    ctx.waitUntil(refreshAllMatchStatuses().catch((e) => console.log(`[cron] refreshAllMatchStatuses failed: ${e}`)));
  },
} satisfies ExportedHandler<Env>;
