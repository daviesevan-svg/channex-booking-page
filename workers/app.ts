import { createRequestHandler } from "react-router";

import { scheduledGoogleAriSync } from "../app/lib/google-ari/push.server";
import { refreshMergedGoogleFeed } from "../app/lib/google-merged-feed.server";

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
  // and keeps the previous snapshot if Channex can't be reached.
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(scheduledGoogleAriSync());
    ctx.waitUntil(refreshMergedGoogleFeed());
  },
} satisfies ExportedHandler<Env>;
