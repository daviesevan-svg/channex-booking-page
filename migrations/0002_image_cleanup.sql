-- Durable, bounded image cleanup. Apply before deploying the matching writers and cron.

CREATE TABLE IF NOT EXISTS image_gc_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    processor_token TEXT, processor_until INTEGER NOT NULL DEFAULT 0,
    deleting_key TEXT
  );

INSERT OR IGNORE INTO image_gc_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS image_gc_property (
    pid TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE IF NOT EXISTS image_gc_write (
    token TEXT PRIMARY KEY, pid TEXT NOT NULL, started_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS image_gc_candidate (
    image_key TEXT PRIMARY KEY, owner_pid TEXT NOT NULL, url TEXT NOT NULL,
    due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, scan_token TEXT
  );

CREATE INDEX IF NOT EXISTS image_gc_candidate_due ON image_gc_candidate (scan_token, due_at);

CREATE TABLE IF NOT EXISTS image_gc_scan (
    scan_token TEXT NOT NULL, pid TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY (scan_token, pid)
  );

CREATE TABLE IF NOT EXISTS image_gc_seen (
    scan_token TEXT NOT NULL, image_key TEXT NOT NULL, pid TEXT NOT NULL,
    PRIMARY KEY (scan_token, image_key, pid)
  );

CREATE TABLE IF NOT EXISTS image_gc_pin (
    pid TEXT NOT NULL, image_key TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (pid, image_key)
  );

CREATE INDEX IF NOT EXISTS image_gc_pin_expiry ON image_gc_pin (expires_at);

CREATE TABLE IF NOT EXISTS image_gc_bootstrap (
    id INTEGER PRIMARY KEY CHECK (id = 1), cursor TEXT, complete INTEGER NOT NULL DEFAULT 0
  );

INSERT OR IGNORE INTO image_gc_bootstrap (id) VALUES (1);

CREATE TABLE IF NOT EXISTS image_gc_deleted (
    image_key TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL
  );
