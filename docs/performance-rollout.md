# Speed and storage optimisation rollout

This change reduces booking-history reads, guest JavaScript, Google ARI delivery work and retained temporary data. It also replaces the image cleanup property ceiling with durable, bounded scans. No production resources are changed by the tests or by opening this PR.

## Deploy in this order

1. Apply the additive D1 migrations to the production `channex-ari` database before the matching Worker is deployed:

   ```sh
   npx wrangler d1 migrations apply channex-ari --remote
   ```

   `0001` adds booking-order and checkout-age indexes; `0002` creates image cleanup coordination tables; `0003` creates the Google enqueue repair table and retry index. These migrations are idempotent and leave existing business records intact. Build the indexes during deployment preparation, since existing rows require indexing. For a disposable local database, use `--local` instead of `--remote`.

2. Deploy using the normal build/deploy pipeline (`npm run deploy` locally). Keep the `GOOGLE_ARI_QUEUE` binding, the `v1-google-ari-queue` SQLite Durable Object migration and all three cron expressions from `wrangler.jsonc`. Exporting `GoogleAriQueue` from the Worker is required. No new secrets are needed. The first deployment introducing this Durable Object must use `wrangler deploy`; `wrangler versions upload` cannot apply a new Durable Object lifecycle migration, so branch preview uploads can remain blocked until that first deployment. See [Cloudflare's migration guidance](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#durable-object-migrations).

3. Verify a Google manual sync reports success, then verify a small inventory update is delivered after the short queue delay. Check Worker logs for retained delivery failures, enqueue repair errors and image cleanup failures. Verify the admin booking page navigates correctly and a guest search loads normally.

The minute cron only retries failed Google queue admissions (up to 25 properties). Per-property Durable Object alarms coalesce and retry normal delivery. The 15-minute cron advances image cleanup (up to 50 properties and 20 candidates per batch). The original six-hour cron still runs reconciliation and existing maintenance, plus checkout-intent retention; the faster schedules do not repeat those expensive jobs.

Do not remove the Durable Object migration tag or binding on a later deploy while work may be queued. An application rollback can leave the additive D1 tables/indexes in place. If rolling back image-reference write hooks independently, disable the new image cleanup cron first so deletion cannot run against untracked writes.

## Behaviour and tradeoffs

- Guest root JavaScript no longer imports the admin English dictionary. Local production builds before/after this change reduced the root module and its transitive JavaScript imports from 116,523 to 79,656 gzip bytes (36,867 bytes, about 32%). This is a bundle measurement, not a measured page-load improvement. CI inspects the emitted router dependency manifest to catch the admin dictionary returning to guest routes.
- Payment return routes use the existing `(pid, reference)` booking index. Booking APIs and admin screens decode only their requested page. Counts, JSON-field filters and deep offsets still require database work; see [booking read details](booking-read-optimisations.md).
- Checkout fingerprints older than 24 hours are deleted in at most five batches of 1,000 per six-hour tick. The normal reuse window remains three hours. Permanent bookings, payment/refund claims and pending-payment lifetimes are unchanged. Concurrent expiry/claim regression tests protect reference reuse.
- Google delivery reads current inventory when processing persisted work, coalesces compatible scopes and serializes each property's sends. Failed deliveries remain queued with backoff; a repair marker committed with webhook inventory covers interruption before queue admission. Full scheduled reconciliation remains the backstop. The queue adds small persistent metadata and one actor per property in exchange for fewer duplicated full-window pushes.
- Image removals are candidates, not immediate deletes. Cleanup waits at least 24 hours and a complete scan of all recorded properties, including clones, before deletion. A bounded bootstrap includes previously removed properties; temporary reference pins bridge KV propagation without requiring a quiet period across all hotels. Candidate and scan state survives restarts. Retained shared images are reconsidered later. Tombstones protect deleted keys against stale forms; these compact metadata rows persist. Failed reads keep candidates pending, and failed R2 deletes retry. See [image cleanup details](image-cleanup.md).
- Dependency installation generates Cloudflare types. On Workers Builds (`WORKERS_CI=1`), it also builds the application before the existing `wrangler versions upload` command, which otherwise encounters the unresolved React Router virtual entry. Normal local/GitHub installs skip compilation. GitHub CI explicitly exercises this Cloudflare build hook once, and `npm run deploy` continues to build before deployment. The current Cloudflare dashboard has no separate build command; adding one would duplicate the install-time build and should be coordinated with removing the hook.

Tests and local builds establish correctness and reduced data movement. Production latency, D1 rows read/written, Durable Object usage and R2 storage savings should be compared after rollout using real traffic; no percentage cost reduction is assumed.
