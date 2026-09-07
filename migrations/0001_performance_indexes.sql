-- New indexes are built during deployment preparation, not on a guest request.
-- Table definitions also allow this migration to run against an empty local DB.
CREATE TABLE IF NOT EXISTS booking (
  pid TEXT NOT NULL, id TEXT NOT NULL, reference TEXT NOT NULL,
  email TEXT NOT NULL, created_at TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active', json TEXT NOT NULL,
  PRIMARY KEY (pid, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_ref ON booking(pid, reference);
CREATE INDEX IF NOT EXISTS booking_email ON booking(pid, email);
CREATE INDEX IF NOT EXISTS booking_created_at ON booking(pid, created_at);

CREATE TABLE IF NOT EXISTS checkout_intent (
  pid TEXT NOT NULL, fingerprint TEXT NOT NULL,
  reference TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (pid, fingerprint)
);
CREATE INDEX IF NOT EXISTS checkout_intent_created_at ON checkout_intent(created_at);
