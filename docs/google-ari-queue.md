# Google ARI incremental delivery and audit reads

Channel notifications persist changes to D1 and enqueue changed room/date or room/rate/date cells in the property's `GoogleAriQueue` Durable Object. The first alarm is one second after admission; additional notifications merge into that work without postponing the first alarm. Rates are read from committed inventory when delivery starts, including **all occupancy rows for each changed product/date**, and retain Google's `Overlay` / `ProductRate` semantics. Equal values on nonadjacent dates remain separate runs.

An availability-only change reads availability cells and sends inventory counts. A product change reads that product's rates/restrictions and sends its prices and restriction state. Full catalog/global-setting requests dominate incremental work, and the existing six-hour reconciliation continues to queue the full configured horizon. Metadata larger than 60,000 characters becomes a full reconciliation request to bound per-property queue storage.

The Durable Object serializes change-driven, manual, disable and reconciliation deliveries. Pending and inflight records live in durable storage. New writes arriving while Google is being contacted remain pending; success only acknowledges the snapshot being delivered. Failure, readiness rejection or a process restart preserves work and retries against current inventory, with exponential delays from five seconds up to one hour. New work wakes the actor promptly. A recovery alarm is stored before network delivery starts; objects without pending work have no periodic wakeup.

Stop-sells and zero counts are sent first. Prices are sent before reopenings or positive counts; rejected prices prevent those reopenings. Each Google HTTP request has a 15-second timeout. A full mixed open/closed snapshot can use five POSTs; small availability changes use one, and rate-only changes normally use two. Measure production POST counts and D1 reads before assigning a cost saving.

Only an explicit ON request clears a durable OFF state. A reconciliation or channel notification with a stale KV flag cannot reopen the property. OFF/ON saves wait for durable admission, then return while delivery runs in the background. Repeating the same explicit setting repeats admission safely, including when a previous settings write succeeded but admission failed. A missing queue binding fails visibly instead of falling back to unordered direct delivery.

## Repair between D1 commit and queue admission

The webhook includes a `google_ari_repair` marker in every atomic inventory-write batch. If the Worker ends or queue admission fails after inventory commit, the marker survives. A minute cron reads up to 25 due markers, queues a full ARI reconciliation, then deletes the marker only if its revision still matches. A concurrent webhook refresh therefore survives an older acknowledgement. Admission failures retain the marker and defer it for a minute, allowing other properties to advance. Disabled properties require no inventory push. Existing Channex acknowledgement/error/recovery semantics remain tied to inventory storage; a downstream failure does not claim that committed inventory failed.

## Deployment

Apply the repository's D1 migration creating `google_ari_repair` **before deploying the Worker**. Deploy the Worker export, `GOOGLE_ARI_QUEUE` binding and SQLite Durable Object migration together, and retain both the minute repair cron and the existing six-hour full reconciliation. The new code does not create the repair table during guest/webhook requests. No production migration or deployment was run as part of this change.

Before wider rollout, use a test Google property to check an availability update, a stop-sell, an occupancy-price update, OFF/ON, and a forced transport failure. Observe Worker/DO logs, Google sync results, POST counts and D1 rows read. `SELECT COUNT(*) FROM google_ari_repair` shows admission backlog; normal operation should drain it quickly. Retained failures log their reason rather than disappearing.

## Audit scope

Channel before/after snapshots now select exact availability room/date and rate room/rate/date cells. Availability-only pushes do not read rates or restrictions. Restriction-only pushes take no audit snapshots because restrictions are intentionally excluded by the existing audit policy. Rate snapshots include all occupancy rows so changing a lower occupancy still produces the same displayed-price audit behavior. Sparse dates remain sparse, and queries stay below D1's 100-bind limit. Snapshot errors remain best effort and do not block the inventory write.

## Validation

Tests cover burst coalescing, full-over-incremental merges, updates during delivery, duplicate alarms, manual/change serialization, failed delivery and readiness retry, instance restart recovery, missing bindings, OFF/ON ordering, stale reconciliation flags, repeated toggle admission, complete occupancy overlays, sparse date gaps, out-of-window dates, close-before-open ordering, rejected rates, bounded repair scans, concurrent repair refreshes, atomic marker placement, and scoped audit semantics.

Protocol references: [Google rate message overlay semantics](https://developers.google.com/hotels/hotel-prices/dev-guide/ari-rate-message), [Google rate XML reference](https://developers.google.com/hotels/hotel-prices/xml-reference/ari-rate), [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), and [Durable Object storage guidance](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).
