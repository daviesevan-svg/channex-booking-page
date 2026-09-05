-- Inventory date indexes (see the CREATE INDEX block in app/lib/ari/schema.server.ts).
--
-- The app creates these itself, in the same schemaOnce batch as the tables, so
-- deploying is enough. Run this by hand FIRST if you would rather not have the
-- one-time index build land on whichever guest request happens to warm a cold
-- isolate:
--
--   npx wrangler d1 execute channex-ari --remote --file docs/ari-date-indexes.sql
--
-- Idempotent either way: whichever runs second is a no-op.
CREATE INDEX IF NOT EXISTS availability_hotel_date ON availability (hotel_code, date);
CREATE INDEX IF NOT EXISTS rate_hotel_date ON rate (hotel_code, date);
CREATE INDEX IF NOT EXISTS restriction_hotel_date ON restriction (hotel_code, date);
