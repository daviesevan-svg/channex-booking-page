# Booking read and availability optimisations

Payment completion for Stripe, Viva and iyzico now uses the existing property/reference point lookup. This preserves finalization, provider verification and failed/refunded outcomes while avoiding reads proportional to a property's booking history. The existing unique `(pid, reference)` index serves these lookups.

The booking read API, management API and admin bookings page now read only a database page. `getBookingsPage` batches the page and its filtered count so both see the same D1 transaction state. Limits remain capped at 100 for `/v1/bookings` and 200 for `/v1/manage/bookings`, defaulting to 50. Malformed, fractional, non-positive limits and negative/unsafe offsets return 422. Admin pages show 50 records with previous/next navigation, retain the overall booking count and property selection, and redirect stale pages to the last available page.

The management API keeps all existing status/lifecycle, check-in date and creation date filters, including inclusive end dates and default-active legacy bookings. It also preserves its historical equal-timestamp insertion order (oldest insert first); the read API and admin retain newest insert first. These ties are explicit and deterministic. Status and check-in filters still evaluate SQLite JSON fields, so they reduce network transfer and application decoding but do not claim an indexed lookup for every filter. Deep offset pages and total counts still require database work.

Apply the versioned `booking_created_at` index on `(pid, created_at)` as part of the D1 migration rollout. The page query works before migration, with the index improving ordered reads. The index adds one entry per booking, including modest storage and write overhead. The runtime schema initializer does not create this performance index during guest requests.

`GET /v1/availability` now validates all inputs before catalog, rates or settings reads:

- Real `YYYY-MM-DD` dates; check-out is 1–60 nights after check-in.
- Adults are integers from 1 to 25, default 2 (the existing guest server adult ceiling).
- Child count is an integer from 0 to 25, default 0; count-only requests use age 8 as before.
- At most 25 child ages, each an integer from 0 to 17. A non-empty age list takes precedence over a valid child count. Invalid supplied values return 400 instead of being partially parsed or silently dropped.
- The age-list string is bounded before splitting, and the child count is bounded before allocating the age array. Ages may include whitespace around individual comma-separated values.

The endpoint retains its previous handling of historical dates; downstream availability gates decide whether a bounded stay is bookable. OpenAPI and MCP descriptions include the new bounds. Booking-creation input contracts are unchanged by this patch.

Regression coverage uses real SQLite for database page results, filtered counts, property isolation and ordering/query plans. Payment return tests cover existing, pending, unknown, incomplete, failed and refunded records, with existing provider binding tests retained. Mocked availability loaders assert zero catalog/settings/rate reads for malformed dates, reversed and oversized stays, invalid ages and huge child counts. These tests establish correctness and bounded data flow, not production latency or cost savings.
