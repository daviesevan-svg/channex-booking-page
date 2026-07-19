import { getConfigKV } from "./config.server";

/** Best-effort fixed-window rate limit backed by KV. Returns true if the action
 *  is allowed, false if the caller has exceeded `limit` within `windowSec`.
 *
 *  Fails open: if KV is unavailable (e.g. local dev) the action is allowed, so
 *  this is a throttle to blunt brute force, not a hard security boundary. The
 *  real defence is the unguessable booking reference. */
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

/** A stable per-client key for throttling, from Cloudflare's connecting-IP
 *  header (falls back to X-Forwarded-For, then a constant for local dev). */
export function clientKey(request: Request): string {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "local";
  return ip;
}
