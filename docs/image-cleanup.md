# Durable image cleanup

Removed images enter `image_gc_candidate` in D1. They remain in R2 for at least
24 hours, then `processImageCleanup()` scans up to 50 properties for a batch of
up to 20 candidates. Progress is stored in `image_gc_scan` and `image_gc_seen`;
there is no 100-property cutoff. A later cron tick resumes incomplete work.

Before deletion is enabled, a bounded bootstrap lists up to 100 legacy
`property_tombstone:` keys per tick and records their property IDs, preserving
removed clones and their retained content. Every registered property is checked, along with candidate owners and properties
recorded by reference writes. The latter includes a clone whose content was
copied before its registry entry was created, and keeps recorded references in
scope after a property is removed from the registry. Each scan strictly parses
all eight KV stores (`gallery`, `site`, `catalog_rooms`, `extras`,
`voucher_products`, `settings`, `content`, `overrides`) and reads sold-voucher
snapshot images from D1. Missing keys are empty; failed reads and malformed JSON
abort the slice without marking that property complete. Hidden/localized content
and inactive/sold products still protect their images.

`CONFIG_KV` writes to those keys, and sold-voucher writes, obtain a D1 write lease
before storing content. Proposed image keys are pinned in D1 before the write,
and receive an initial 48-hour lifetime plus at least 24 hours after completion
(without shortening another writer's pin), so eventual KV propagation cannot
hide a newly added reference. Strict scans merge these pins with stored content;
expiring pins invalidates the property's scan and requires another strict read.
This does not require a quiet 24-hour window across the platform. A changed
property is rescanned; unchanged properties keep their progress. The hooks work
even outside a request-cache scope.

Final deletion atomically checks that every property is scanned at its current
revision and that no reference writer is in flight, and creates a permanent
image-key tombstone. Unrelated writes remain available during the R2 request.
A stale form attempting to reintroduce that deleted key is refused and must upload
the image again. Absolute URLs, resize queries and fragments are canonicalized to
the same object key for both reference scans and tombstone checks. Tombstones are
deliberately retained: dropping them would allow old forms/API payloads to create
broken references. They are small D1 rows in place of large R2 objects; monitor
their count as part of normal storage metrics.

Failed R2 deletes remain queued with a six-hour retry delay. A referenced image
also stays queued for a later scan, since its last reference may subsequently be
removed by a clone that does not own the source object. Interrupted deletion is
retried before new scan work. Failed source reads leave prior progress intact.
An interrupted content-write lease is recovered only after 24 hours. Its proposed
reference pins start with a 48-hour lifetime, preserving another day of protection
before a fresh read. This exceeds the Worker's request/cron execution window and
avoids treating an interrupted write as proof that the image disappeared.

## Deployment and operation

1. Apply the image-cleanup migration (the canonical statements are
   `IMAGE_GC_SCHEMA` in `app/lib/image-gc-store.server.ts`).
2. Deploy the writer hooks and processor together. `processImageCleanup()` needs
   the existing D1, CONFIG_KV and IMAGES bindings, plus the existing `property`
   registry table. D1-less development never deletes images.
3. Invoke `processImageCleanup()` from the scheduled handler. A 15-minute cadence
   is suitable; it must not cause unrelated six-hour jobs to run every 15 minutes.
   A 103-property batch needs three default-size slices after grace.
4. Monitor candidate count/oldest due time, attempts, outstanding write leases,
   and logged read/delete failures. Concurrent changes can postpone a slice;
   ordinary daily edits do not reset a platform-wide grace period. Incomplete
   scans never permit deletion.

All image reference writes must use the wrapped `getConfigKV()` path or
`withImageReferenceWrite()` for D1 snapshots. Manual KV/D1 changes bypassing these
hooks require pausing the processor and restarting scans after a full grace
period. New image-bearing stores must be added to both the write-key list and the
strict reference reader. Existing objects that never generated a removal event
are not bulk-deleted by this change. Legacy removed property IDs are backfilled from tombstones before cleanup starts.
Historical orphan discovery needs a separate audited inventory job.

Relevant tests: `image-gc-durable.test.ts` covers bounded progress over 103
properties, tombstone bootstrap, daily edits during propagation, pin expiry,
late/shared/aliased references, hidden content and sold vouchers, source
failures/corruption, retries, concurrent re-adds, unrelated writes during deletion,
interrupted deletion, and in-flight writers. `image-gc-scope.test.ts` preserves
ownership boundaries; `room-photo-upload.test.ts` exercises the real save action,
durable candidate, grace period and eventual deletion.
