// Durable image cleanup coordination. Keep this module independent of content
// readers: CONFIG_KV writes use it before a new image reference becomes visible.
import { env } from "cloudflare:workers";

export const IMAGE_GC_GRACE_MS = 24 * 60 * 60 * 1000;
export const IMAGE_GC_RETRY_MS = 6 * 60 * 60 * 1000;

export const IMAGE_GC_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS image_gc_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    processor_token TEXT, processor_until INTEGER NOT NULL DEFAULT 0,
    deleting_key TEXT
  )`,
  `INSERT OR IGNORE INTO image_gc_state (id) VALUES (1)`,
  `CREATE TABLE IF NOT EXISTS image_gc_property (
    pid TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS image_gc_write (
    token TEXT PRIMARY KEY, pid TEXT NOT NULL, started_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS image_gc_candidate (
    image_key TEXT PRIMARY KEY, owner_pid TEXT NOT NULL, url TEXT NOT NULL,
    due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, scan_token TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS image_gc_candidate_due ON image_gc_candidate (scan_token, due_at)`,
  `CREATE TABLE IF NOT EXISTS image_gc_scan (
    scan_token TEXT NOT NULL, pid TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY (scan_token, pid)
  )`,
  `CREATE TABLE IF NOT EXISTS image_gc_seen (
    scan_token TEXT NOT NULL, image_key TEXT NOT NULL, pid TEXT NOT NULL,
    PRIMARY KEY (scan_token, image_key, pid)
  )`,
  `CREATE TABLE IF NOT EXISTS image_gc_pin (
    pid TEXT NOT NULL, image_key TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (pid, image_key)
  )`,
  `CREATE INDEX IF NOT EXISTS image_gc_pin_expiry ON image_gc_pin (expires_at)`,
  `CREATE TABLE IF NOT EXISTS image_gc_bootstrap (
    id INTEGER PRIMARY KEY CHECK (id = 1), cursor TEXT, complete INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT OR IGNORE INTO image_gc_bootstrap (id) VALUES (1)`,
  `CREATE TABLE IF NOT EXISTS image_gc_deleted (
    image_key TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL
  )`,
];

export function imageGcDb(): D1Database | undefined {
  return (env as unknown as { DB?: D1Database }).DB;
}

let ready: Promise<void> | undefined;
export async function ensureImageGcSchema(): Promise<void> {
  const d = imageGcDb();
  if (!d) return;
  ready ??= d.batch(IMAGE_GC_SCHEMA.map((sql) => d.prepare(sql))).then(() => {}).catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

// This list must cover every KV source read by referencedBy. Clone writes use
// these same keys before their new property enters the registry.
export const IMAGE_REFERENCE_PREFIXES = ["gallery", "site", "catalog_rooms", "extras", "voucher_products", "settings", "content", "overrides"] as const;
const IMAGE_CONTENT_KEYS = new RegExp(`^(?:${IMAGE_REFERENCE_PREFIXES.join("|")}):(.+)$`);
export function imageReferenceProperty(key: string): string | undefined {
  return IMAGE_CONTENT_KEYS.exec(key)?.[1];
}

/** Canonical object key for a stored reference. Absolute URLs and resize/query
 * aliases must protect the same object. Any absolute host is accepted here
 * conservatively; a false retained object is safer than a broken shared photo. */
export function imageReferenceKey(value: unknown): string | null {
  if (typeof value !== "string" || !(value.startsWith("/images/") || /^https?:\/\//i.test(value))) return null;
  try {
    const path = decodeURIComponent(new URL(value, "https://image-gc.invalid").pathname);
    if (!path.startsWith("/images/")) return null;
    const key = path.slice(8);
    return key && !key.includes("..") ? key : null;
  } catch { return null; }
}

/** Extract image paths anywhere in a JSON value, including hidden content. */
export function imageReferenceKeys(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const key = imageReferenceKey(v);
      if (key) found.add(key);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  if (typeof value === "string") {
    try { visit(JSON.parse(value)); } catch { visit(value); }
  } else visit(value);
  return [...found];
}

/** Mark references dirty BEFORE storing them. D1 failures fail this content
 * write closed. Unrelated saves can continue during R2 deletion; tombstones
 * reject a stale form trying to re-add a key whose deletion already started.
 * A failed/interrupted write remains conservative: scans merge the pins
 * with persisted content. Proposed images are pinned in D1
 * until the write has had a full day to propagate, even if the KV write fails. */
export async function withImageReferenceWrite<T>(pid: string, value: unknown, write: () => Promise<T>): Promise<T> {
  const d = imageGcDb();
  if (!d) return write(); // local/dev without D1 never runs durable deletion
  await ensureImageGcSchema();
  const token = crypto.randomUUID();
  const now = Date.now();
  const keys = imageReferenceKeys(value);
  await d.batch([
    d.prepare(`INSERT INTO image_gc_write (token, pid, started_at) VALUES (?, ?, ?)`).bind(token, pid, now),
    d.prepare(`INSERT INTO image_gc_property (pid, revision) VALUES (?, 1)
      ON CONFLICT(pid) DO UPDATE SET revision=revision+1`).bind(pid),
    // Pin proposed references before KV can expose them. This is the bridge
    // over KV propagation: scans need no platform-wide quiet period.
    d.prepare(`INSERT INTO image_gc_pin (pid,image_key,expires_at)
      SELECT ?, value, ? FROM json_each(?) WHERE 1
      ON CONFLICT(pid,image_key) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)`)
      .bind(pid, now + 2 * IMAGE_GC_GRACE_MS, JSON.stringify(keys)),
  ]);
  try {
    for (let i = 0; i < keys.length; i += 90) {
      const chunk = keys.slice(i, i + 90);
      const deleted = await d.prepare(`SELECT image_key FROM image_gc_deleted
        WHERE image_key IN (${chunk.map(() => "?").join(",")}) LIMIT 1`).bind(...chunk).first<{ image_key: string }>();
      if (deleted) throw new Error("This image was removed from storage. Upload it again before saving.");
    }
    return await write();
  } finally {
    // A termination between the KV write and this batch leaves an active lease;
    // the cron recovers it only while its initial 48-hour pins still protect it.
    await d.batch([
      d.prepare(`UPDATE image_gc_property SET revision=revision+1 WHERE pid=?`).bind(pid),
      // Never shorten another concurrent writer's initial protection; its
      // request may terminate without reaching its own completion batch.
      d.prepare(`UPDATE image_gc_pin SET expires_at=MAX(expires_at,?) WHERE pid=? AND image_key IN (SELECT value FROM json_each(?))`)
        .bind(Date.now() + IMAGE_GC_GRACE_MS, pid, JSON.stringify(keys)),
      d.prepare(`DELETE FROM image_gc_write WHERE token=?`).bind(token),
    ]);
  }
}
