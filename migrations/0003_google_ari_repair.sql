-- A webhook's inventory batch records this marker atomically. It is removed
-- only after the matching revision has been accepted by the durable queue.
CREATE TABLE IF NOT EXISTS google_ari_repair (
  pid TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  next_attempt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS google_ari_repair_due ON google_ari_repair(next_attempt, pid);
