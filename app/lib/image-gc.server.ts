// Durable R2 garbage collection. Saves enqueue candidates; the cron scans a
// bounded number of properties per tick and resumes where it stopped. A shared
// image is deleted only after every reference source has been checked at its
// current write revision. Content writes mark dirty before storing and cannot
// race the final deletion guard (see image-gc-store.server.ts).
import { fireAndForget } from "./d1.server";
import { getConfigKV, getImagesBucket } from "./config.server";
import { ownsImageKey, IMAGE_PATH as IMAGE_PATH_PREFIX } from "./image-paths";
import { voucherSnapshotImages } from "./vouchers.server";
import {
  ensureImageGcSchema, imageGcDb, imageReferenceKey, imageReferenceKeys, IMAGE_REFERENCE_PREFIXES, IMAGE_GC_GRACE_MS, IMAGE_GC_RETRY_MS,
} from "./image-gc-store.server";

const IMAGE_PATH = IMAGE_PATH_PREFIX;
const PROCESSOR_LEASE_MS = 20 * 60 * 1000;
const MAX_PROPERTIES_PER_TICK = 50;
const MAX_CANDIDATES_PER_BATCH = 20;

/**
 * The R2 key behind one of our uploaded-image urls, or null for anything we
 * don't own.
 *
 * A filter, not just string surgery: the room editor also accepts pasted
 * absolute urls, and KV can be hand-edited, so a value reaching bucket.delete()
 * has to be one we know we wrote.
 */
export function imageKeyOf(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith(IMAGE_PATH)) return null;
  if (url.includes("..")) return null;
  return imageReferenceKey(url);
}

/** Every image url one property's stores still point at. Hidden sections and
 *  inactive extras count — they're still referenced, just not rendered. */
async function referencedBy(pid: string): Promise<string[]> {
  const kv = getConfigKV();
  if (!kv) throw new Error("Image cleanup requires CONFIG_KV reference storage.");
  // Display-oriented helpers intentionally fall back to defaults on malformed
  // or unavailable content. GC must not turn such a failure into "unreferenced".
  // Read each raw source strictly; parsing all fields also includes hidden,
  // inactive and localized images that are not currently rendered.
  const values = await Promise.all(IMAGE_REFERENCE_PREFIXES.map(async (prefix) => {
    const raw = await kv.get(`${prefix}:${pid}`);
    return raw === null ? null : JSON.parse(raw);
  }));
  const keys = values.flatMap(imageReferenceKeys);
  const pins = (await imageGcDb()!.prepare(`SELECT image_key FROM image_gc_pin WHERE pid=? AND expires_at>?`)
    .bind(pid, Date.now()).all<{ image_key: string }>()).results ?? [];
  return [...keys.map((key) => `${IMAGE_PATH}${key}`), ...pins.map((p) => `${IMAGE_PATH}${p.image_key}`),
    ...imageReferenceKeys(await voucherSnapshotImages(pid)).map((key) => `${IMAGE_PATH}${key}`)];
}

/** Persist removals even when scanning or R2 is unavailable. The historical
 * name remains for callers, but deletion now happens after grace in the cron. */
export async function deleteUnreferencedImages(pid: string, removed: string[]): Promise<void> {
  const d = imageGcDb();
  if (!d || !getImagesBucket()) return;
  const own = new Map<string, string>();
  for (const url of removed) {
    const key = imageKeyOf(url);
    if (key && ownsImageKey(pid, key)) own.set(key, `${IMAGE_PATH}${key}`);
  }
  if (!own.size) return;
  await ensureImageGcSchema();
  const due = Date.now() + IMAGE_GC_GRACE_MS;
  const stmts = [...own].map(([key, url]) => d.prepare(
    `INSERT INTO image_gc_candidate (image_key, owner_pid, url, due_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(image_key) DO UPDATE SET due_at=excluded.due_at, scan_token=NULL`,
  ).bind(key, pid, url, due));
  for (let i = 0; i < stmts.length; i += 50) await d.batch(stmts.slice(i, i + 50));
}

export function queueImageCleanup(pid: string, removed: string[]): void {
  if (!removed.length) return;
  fireAndForget(deleteUnreferencedImages(pid, removed).catch((err) => console.error("image gc: enqueue failed", err)));
}

type Candidate = { image_key: string; owner_pid: string; url: string };
type PropertyScan = { pid: string; revision: number };

// A clone's content is written BEFORE its registry entry. Recorded writers and
// candidate owners therefore belong in the universe too. Keeping these rows
// after registry removal also preserves that property's retained content.
const ALL_PROPERTIES = `SELECT id AS pid FROM property
  UNION SELECT pid FROM image_gc_property
  UNION SELECT owner_pid AS pid FROM image_gc_candidate`;
const INCOMPLETE = `SELECT 1 FROM (${ALL_PROPERTIES}) p
  LEFT JOIN image_gc_property v ON v.pid=p.pid
  LEFT JOIN image_gc_scan s ON s.pid=p.pid AND s.scan_token=?
  WHERE s.pid IS NULL OR s.revision!=COALESCE(v.revision, 0)`;

export interface ImageCleanupResult {
  scannedProperties: number;
  deletedImages: number;
  retainedImages: number;
  pending: boolean;
}

/** One bounded cron slice. No property-count ceiling: incomplete scans remain
 * durable, and a later tick picks up missing/changed properties. The deletion
 * guard rechecks completeness atomically. Its tombstone prevents any writer
 * or stale form reintroducing a key after that deletion, including after a crash between R2 and D1. */
export async function processImageCleanup(options: { propertyLimit?: number } = {}): Promise<ImageCleanupResult> {
  const result: ImageCleanupResult = { scannedProperties: 0, deletedImages: 0, retainedImages: 0, pending: false };
  const d = imageGcDb();
  const bucket = getImagesBucket();
  if (!d || !bucket) return result;
  await ensureImageGcSchema();
  const now = Date.now();
  const processor = crypto.randomUUID();
  const claim = await d.prepare(`UPDATE image_gc_state SET processor_token=?, processor_until=?
    WHERE id=1 AND processor_until<=?`).bind(processor, now + PROCESSOR_LEASE_MS, now).run();
  if (claim.meta.changes !== 1) return { ...result, pending: true };

  try {
    // Removed properties retain their content for same-owner restoration. They
    // predate writer tracking, so bootstrap tombstone IDs in bounded KV pages
    // before authorizing any deletion. Newly removed properties are recorded by
    // their settings write hook, including removals during this backfill.
    const bootstrap = await d.prepare(`SELECT cursor,complete FROM image_gc_bootstrap WHERE id=1`)
      .first<{ cursor: string | null; complete: number }>();
    if (!bootstrap?.complete) {
      const kv = getConfigKV();
      if (!kv) throw new Error("Image cleanup requires CONFIG_KV reference storage.");
      const page = await kv.list({ prefix: "property_tombstone:", limit: 100, ...(bootstrap?.cursor ? { cursor: bootstrap.cursor } : {}) });
      const ids = page.keys.map((entry) => d.prepare(`INSERT OR IGNORE INTO image_gc_property (pid) VALUES (?)`)
        .bind(entry.name.slice("property_tombstone:".length)));
      for (let i = 0; i < ids.length; i += 50) await d.batch(ids.slice(i, i + 50));
      // Advance only after every ID was recorded. Retrying a partial page is safe.
      await d.prepare(`UPDATE image_gc_bootstrap SET cursor=?,complete=? WHERE id=1`)
        .bind(page.list_complete ? null : page.cursor, page.list_complete ? 1 : 0).run();
      if (!page.list_complete) return { ...result, pending: true };
    }
    // Expiring temporary evidence also invalidates any cached scan so a long
    // running batch must strictly re-read the now-propagated content.
    await d.batch([
      d.prepare(`UPDATE image_gc_property SET revision=revision+1 WHERE pid IN
        (SELECT pid FROM image_gc_pin WHERE expires_at<=?)`).bind(now),
      d.prepare(`DELETE FROM image_gc_pin WHERE expires_at<=?`).bind(now),
    ]);
    // A terminated content request can leave a lease behind. Its initial pins
    // protect references for 48 hours; recovering the lease after a day still
    // leaves a full day before pin expiry forces another strict content read.
    // Ordinary errors release their own lease in finally.
    await d.batch([
      d.prepare(`UPDATE image_gc_property SET revision=revision+1
        WHERE pid IN (SELECT pid FROM image_gc_write WHERE started_at<?)`).bind(now - IMAGE_GC_GRACE_MS),
      d.prepare(`DELETE FROM image_gc_write WHERE started_at<?`).bind(now - IMAGE_GC_GRACE_MS),
    ]);

    // Recover a crash after the atomic deletion guard. The tombstone was
    // written before R2, so retrying that delete can never remove a new reference.
    const interrupted = await d.prepare(`SELECT deleting_key FROM image_gc_state WHERE id=1`)
      .first<{ deleting_key: string | null }>();
    if (interrupted?.deleting_key) {
      await bucket.delete(interrupted.deleting_key);
      await d.batch([
        d.prepare(`DELETE FROM image_gc_candidate WHERE image_key=?`).bind(interrupted.deleting_key),
        d.prepare(`UPDATE image_gc_state SET deleting_key=NULL WHERE id=1 AND processor_token=?`).bind(processor),
      ]);
      result.deletedImages++;
    }

    let scan = await d.prepare(`SELECT scan_token FROM image_gc_candidate WHERE scan_token IS NOT NULL LIMIT 1`)
      .first<{ scan_token: string }>();
    if (!scan) {
      const token = crypto.randomUUID();
      await d.prepare(`UPDATE image_gc_candidate SET scan_token=? WHERE image_key IN (
        SELECT image_key FROM image_gc_candidate WHERE scan_token IS NULL AND due_at<=? ORDER BY due_at, image_key LIMIT ?
      )`).bind(token, now, MAX_CANDIDATES_PER_BATCH).run();
      scan = await d.prepare(`SELECT scan_token FROM image_gc_candidate WHERE scan_token=? LIMIT 1`).bind(token)
        .first<{ scan_token: string }>();
      // Also discard interrupted/invalidated scan metadata, never candidate rows.
      await d.batch([
        d.prepare(`DELETE FROM image_gc_scan WHERE scan_token NOT IN (SELECT scan_token FROM image_gc_candidate WHERE scan_token IS NOT NULL)`),
        d.prepare(`DELETE FROM image_gc_seen WHERE scan_token NOT IN (SELECT scan_token FROM image_gc_candidate WHERE scan_token IS NOT NULL)`),
      ]);
    }
    if (!scan) return result;
    const token = scan.scan_token;
    result.pending = true;
    const candidates = (await d.prepare(`SELECT image_key, owner_pid, url FROM image_gc_candidate WHERE scan_token=?`)
      .bind(token).all<Candidate>()).results ?? [];
    const byUrl = new Map(candidates.map((c) => [c.url, c.image_key]));
    const limit = Math.min(MAX_PROPERTIES_PER_TICK, Math.max(1, Math.floor(options.propertyLimit ?? MAX_PROPERTIES_PER_TICK)));
    const properties = (await d.prepare(`SELECT p.pid, COALESCE(v.revision, 0) AS revision FROM (${ALL_PROPERTIES}) p
      LEFT JOIN image_gc_property v ON v.pid=p.pid
      LEFT JOIN image_gc_scan s ON s.pid=p.pid AND s.scan_token=?
      WHERE (s.pid IS NULL OR s.revision!=COALESCE(v.revision, 0))
      AND NOT EXISTS (SELECT 1 FROM image_gc_write w WHERE w.pid=p.pid)
      ORDER BY p.pid LIMIT ?`).bind(token, limit).all<PropertyScan>()).results ?? [];

    for (const p of properties) {
      // Any failed source read aborts the slice. Progress already stored for
      // earlier properties survives; this property never acquires a "scanned" row.
      const matches = [...new Set((await referencedBy(p.pid)).flatMap((url) => byUrl.has(url) ? [byUrl.get(url)!] : []))];
      const unchanged = `COALESCE((SELECT revision FROM image_gc_property WHERE pid=?),0)=?
        AND NOT EXISTS (SELECT 1 FROM image_gc_write WHERE pid=?)
        AND (SELECT processor_token FROM image_gc_state WHERE id=1)=?`;
      const args = [p.pid, p.revision, p.pid, processor];
      const stmts = [
        d.prepare(`DELETE FROM image_gc_seen WHERE scan_token=? AND pid=? AND ${unchanged}`).bind(token, p.pid, ...args),
        ...matches.map((key) => d.prepare(`INSERT OR IGNORE INTO image_gc_seen (scan_token,image_key,pid)
          SELECT ?,?,? WHERE ${unchanged}`).bind(token, key, p.pid, ...args)),
        d.prepare(`INSERT INTO image_gc_scan (scan_token,pid,revision) SELECT ?,?,? WHERE ${unchanged}
          ON CONFLICT(scan_token,pid) DO UPDATE SET revision=excluded.revision`).bind(token, p.pid, p.revision, ...args),
      ];
      await d.batch(stmts);
      result.scannedProperties++;
    }

    if (await d.prepare(INCOMPLETE).bind(token).first()) return result;
    if (await d.prepare(`SELECT 1 FROM image_gc_write LIMIT 1`).first()) return result;

    for (const candidate of candidates) {
      const retained = await d.prepare(`SELECT 1 FROM image_gc_seen WHERE scan_token=? AND image_key=? LIMIT 1`)
        .bind(token, candidate.image_key).first();
      if (retained) {
        // Keep it as a retryable candidate. A clone may later remove a source's
        // photo, and that clone is correctly forbidden from deleting source keys.
        await d.prepare(`UPDATE image_gc_candidate SET scan_token=NULL, due_at=? WHERE image_key=? AND scan_token=?`)
          .bind(now + IMAGE_GC_GRACE_MS, candidate.image_key, token).run();
        result.retainedImages++;
        continue;
      }
      const guarded = await d.batch([
        d.prepare(`UPDATE image_gc_state SET deleting_key=? WHERE id=1 AND processor_token=? AND deleting_key IS NULL
          AND NOT EXISTS (SELECT 1 FROM image_gc_write)
          AND NOT EXISTS (${INCOMPLETE})
          AND EXISTS (SELECT 1 FROM image_gc_candidate WHERE image_key=? AND scan_token=? AND due_at<=?)`)
          .bind(candidate.image_key, processor, token, candidate.image_key, token, now),
        d.prepare(`INSERT OR IGNORE INTO image_gc_deleted (image_key,deleted_at)
          SELECT ?,? WHERE (SELECT deleting_key FROM image_gc_state WHERE id=1)=?`)
          .bind(candidate.image_key, now, candidate.image_key),
      ]);
      if (guarded[0].meta.changes !== 1) return result;
      try {
        await bucket.delete(candidate.image_key);
        await d.prepare(`DELETE FROM image_gc_candidate WHERE image_key=?`).bind(candidate.image_key).run();
        result.deletedImages++;
      } catch (error) {
        await d.prepare(`UPDATE image_gc_candidate SET attempts=attempts+1, scan_token=NULL, due_at=? WHERE image_key=?`)
          .bind(now + IMAGE_GC_RETRY_MS, candidate.image_key).run();
        console.error("image gc: delete will retry", error);
      } finally {
        await d.prepare(`UPDATE image_gc_state SET deleting_key=NULL WHERE id=1 AND processor_token=?`).bind(processor).run();
      }
    }
    await d.batch([
      d.prepare(`DELETE FROM image_gc_scan WHERE scan_token=?`).bind(token),
      d.prepare(`DELETE FROM image_gc_seen WHERE scan_token=?`).bind(token),
    ]);
    result.pending = Boolean(await d.prepare(`SELECT 1 FROM image_gc_candidate LIMIT 1`).first());
    return result;
  } finally {
    await d.prepare(`UPDATE image_gc_state SET processor_token=NULL, processor_until=0 WHERE id=1 AND processor_token=?`).bind(processor).run();
  }
}
