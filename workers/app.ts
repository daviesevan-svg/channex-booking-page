import { createRequestHandler } from "react-router";

import { scheduledGoogleAriSync } from "../app/lib/google-ari/push.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request) {
    return requestHandler(request);
  },
  // Cron (see wrangler.jsonc `triggers.crons`): keep Google's ARI in sync by
  // re-pushing every ARI-enabled property. A backstop to the change-driven and
  // admin-edit pushes so Google never drifts even if a live push is missed.
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(scheduledGoogleAriSync());
  },
} satisfies ExportedHandler<Env>;
