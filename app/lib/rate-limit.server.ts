import { getConfigKV, getDB } from "./config.server";
import { db, schemaOnce } from "./d1.server";

/** Best-effort fixed-window rate limit backed by KV. Returns true if the action
 *  is allowed, false if the caller has exceeded `limit` within `windowSec`.
 *
 *  Fails open: if KV is unavailable (e.g. local dev) the action is allowed, so
 *  this is a throttle to blunt brute force, not a hard security boundary. The
 *  real defence is the unguessable booking reference.
 *
 *  Also racy: two concurrent gets can both read the same count and both put
 *  count+1, so a `limit` of 1 can admit two callers. Fine for a blunt throttle;
 *  not fine for a 1-per-hour inventory ceiling — use claimWindow() for that. */
export async function rateLimit(
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const kv = getConfigKV();
  if (!kv) return true;
  const key = `rl:${bucket}`;
  const count = Number((await kv.get(key)) ?? 0) || 0;
  if (count >= limit) return false;
  // KV's minimum TTL is 60s. Re-putting keeps a single window per burst of
  // attempts; once over the limit we stop writing so the key expires and frees.
  await kv.put(key, String(count + 1), { expirationTtl: Math.max(60, windowSec) });
  return true;
}

/** Read-only check: has this bucket already exceeded `limit`? Unlike
 *  rateLimit() it never increments — use it to short-circuit BEFORE doing the
 *  expensive work, and call rateLimit() afterwards only on the outcomes that
 *  should count (e.g. failed lookups). Fails open without KV. */
export async function overLimit(bucket: string, limit: number): Promise<boolean> {
  const kv = getConfigKV();
  if (!kv) return false;
  const count = Number((await kv.get(`rl:${bucket}`)) ?? 0) || 0;
  return count >= limit;
}

// One row per bucket. The PRIMARY KEY is the latch: INSERT ON CONFLICT DO
// NOTHING, same as claimBooking / claimVoucher. A live row older than the
// window can be stolen with UPDATE … WHERE created_at < cutoff — also atomic,
// so two racers after expiry cannot both win.
const ensureClaimSchema = schemaOnce((d) => [
  d.prepare(
    `CREATE TABLE IF NOT EXISTS rate_claim (
        bucket TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )`,
  ),
]);

/** Atomically claim a 1-per-window slot. Returns true if this caller won,
 *  false if another claim is still live. Rolling window: a row older than
 *  `windowSec` is stealable.
 *
 *  Fails open without D1 so local/dev without the binding still works. When D1
 *  is bound, two concurrent callers cannot both win — unlike rateLimit(). */
export async function claimWindow(bucket: string, windowSec: number): Promise<boolean> {
  if (!getDB()) return true;
  await ensureClaimSchema();
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - windowSec * 1000).toISOString();
  const inserted = await db()
    .prepare(`INSERT INTO rate_claim (bucket, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING`)
    .bind(bucket, now)
    .run();
  if (inserted.meta.changes === 1) return true;
  const stolen = await db()
    .prepare(`UPDATE rate_claim SET created_at = ? WHERE bucket = ? AND created_at < ?`)
    .bind(now, bucket, cutoff)
    .run();
  return stolen.meta.changes === 1;
}

/** A stable per-client key for throttling, from Cloudflare's connecting-IP
 *  header (falls back to X-Forwarded-For, then a constant for local dev). */
export function clientKey(request: Request): string {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "local";
  return ip;
}
