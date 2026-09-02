// Public REST API authentication: per-property API keys (Stripe-style
// sk_live_/sk_test_ for the guest/booking surface, ak_live_ for the
// management surface). Keys are shown once at creation and stored only as an
// HMAC-SHA256 hash. A global reverse index maps hash → { pid, keyId } for O(1)
// auth lookup. test-mode keys force simulated bookings (no Channex push).
//
// The two SCOPES are disjoint on purpose (docs/management-api.md §2): a
// booking key must not be able to rewrite the property, and a management key
// must not be able to create bookings — a hotel that needs both holds two
// keys, and a leaked key's blast radius is readable from its prefix. There is
// no test variant of a management key: a management write is a write.
import { getConfig, getConfigKV } from "./config.server";
import { requireCanonicalHost } from "./domains.server";
import { getProperty } from "./properties.server";
import { rateLimit } from "./rate-limit.server";

/** Per key, per 10 minutes (docs/management-api.md §2). Reads are generous;
 *  writes are what an agent loop can do damage with. Route-specific buckets
 *  (invites, image import) sit on top of these. */
export const MANAGE_RATE_WINDOW_SEC = 600;
export const MANAGE_READ_LIMIT = 300;
export const MANAGE_WRITE_LIMIT = 60;

export type ApiKeyMode = "live" | "test";
export type ApiKeyScope = "book" | "manage";

/** Stored per-property (never returned raw). `hash` enables revocation; only
 *  `last4` is shown to the operator. */
export interface ApiKeyRecord {
  id: string;
  label: string;
  mode: ApiKeyMode;
  /** Absent on records issued before scopes existed — those are all "book". */
  scope?: ApiKeyScope;
  hash: string;
  last4: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/** Safe shape for admin display — no hash. */
export type ApiKeyView = Omit<ApiKeyRecord, "hash">;

export interface ApiAuth {
  pid: string;
  keyId: string;
  mode: ApiKeyMode;
  scope: ApiKeyScope;
}

const keysKey = (pid: string) => `api_keys:${pid}`;
const indexKey = (hash: string) => `apikey:${hash}`;

async function readJson<T>(key: string): Promise<T | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
async function writeJson(key: string, value: unknown): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(key, JSON.stringify(value));
}

const enc = (s: string) => new TextEncoder().encode(s);

/** HMAC-SHA256(rawKey, sessionSecret) as hex — one-way; the raw key can't be
 *  recovered from what we store. */
async function hashKey(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc(getConfig().sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc(raw));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 24): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const view = ({ hash: _hash, ...rest }: ApiKeyRecord): ApiKeyView => rest;

/** Standard JSON error envelope used by every /v1 route. */
export function apiError(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

export async function listApiKeys(pid: string): Promise<ApiKeyView[]> {
  const recs = (await readJson<ApiKeyRecord[]>(keysKey(pid))) ?? [];
  return recs.filter((r) => !r.revokedAt).map(view);
}

/** Create a key. Returns the raw key ONCE (never retrievable again).
 *  Management keys are always live — there is nothing for a test mode to
 *  simulate on a write, so `mode` is ignored when scope is "manage". */
export async function issueApiKey(
  pid: string,
  opts: { label: string; mode: ApiKeyMode; scope?: ApiKeyScope },
): Promise<{ key: ApiKeyView; raw: string }> {
  const scope: ApiKeyScope = opts.scope ?? "book";
  const mode: ApiKeyMode = scope === "manage" ? "live" : opts.mode;
  const raw = `${scope === "manage" ? "ak" : "sk"}_${mode}_${randomToken()}`;
  const hash = await hashKey(raw);
  const rec: ApiKeyRecord = {
    id: randomToken(8),
    label: opts.label.trim() || "API key",
    mode,
    scope,
    hash,
    last4: raw.slice(-4),
    createdAt: new Date().toISOString(),
  };
  const recs = (await readJson<ApiKeyRecord[]>(keysKey(pid))) ?? [];
  recs.push(rec);
  await writeJson(keysKey(pid), recs);
  await writeJson(indexKey(hash), { pid, keyId: rec.id, mode: rec.mode, scope });
  return { key: view(rec), raw };
}

export async function revokeApiKey(pid: string, keyId: string): Promise<boolean> {
  const recs = (await readJson<ApiKeyRecord[]>(keysKey(pid))) ?? [];
  const rec = recs.find((r) => r.id === keyId && !r.revokedAt);
  if (!rec) return false;
  rec.revokedAt = new Date().toISOString();
  await writeJson(keysKey(pid), recs);
  const kv = getConfigKV();
  if (kv) await kv.delete(indexKey(rec.hash)); // index gone → key no longer authenticates
  return true;
}

/** Revokes every live key of a property — for deletion, so a key issued to a
 *  property that no longer exists can't keep driving its leftover data. */
export async function revokeAllApiKeys(pid: string): Promise<number> {
  const recs = (await readJson<ApiKeyRecord[]>(keysKey(pid))) ?? [];
  const kv = getConfigKV();
  const now = new Date().toISOString();
  let revoked = 0;
  for (const rec of recs) {
    if (rec.revokedAt) continue;
    rec.revokedAt = now;
    revoked++;
    if (kv) await kv.delete(indexKey(rec.hash));
  }
  if (revoked) await writeJson(keysKey(pid), recs);
  return revoked;
}

/** Resolve the API key on a request and require it to carry `scope`. Returns
 *  the auth context, or a ready-to-return JSON error Response (401/403).
 *
 *  Every existing guest endpoint calls this with the default scope, so legacy
 *  records (which predate scopes and are all booking keys) keep working, and a
 *  management key on a guest endpoint — or the reverse — is a 403 that names
 *  the right key kind rather than a mystery 401. */
export async function authenticateApiKey(request: Request, scope: ApiKeyScope = "book"): Promise<ApiAuth | Response> {
  const auth = await identifyApiKey(request);
  if (auth instanceof Response) return auth;
  if (auth.scope !== scope) {
    return scope === "manage"
      ? apiError(403, "wrong_key_scope", "This endpoint requires a management key (ak_…). Booking keys (sk_…) cannot manage the property.")
      : apiError(403, "wrong_key_scope", "This endpoint requires a booking key (sk_…). Management keys (ak_…) cannot search or book.");
  }
  if (scope === "manage") {
    // The management surface had no throttle at all — an agent loop (or a
    // leaked key) could send unbounded invite requests, image imports and
    // Google resyncs. Blunt KV limiter (racy at the margin, fine for this);
    // MCP tool calls re-dispatch into these routes, so they count too.
    const write = request.method !== "GET" && request.method !== "HEAD";
    const limit = write ? MANAGE_WRITE_LIMIT : MANAGE_READ_LIMIT;
    const ok = await rateLimit(`apimanage:${write ? "w" : "r"}:${auth.pid}:${auth.keyId}`, limit, MANAGE_RATE_WINDOW_SEC);
    if (!ok) {
      return apiError(
        429,
        "rate_limited",
        `Too many management ${write ? "writes" : "reads"}: at most ${limit} per 10 minutes per key. Wait a few minutes and retry.`,
      );
    }
  }
  return auth;
}

/** Resolve the key WITHOUT enforcing a scope — for the one place that adapts
 *  to whichever key it was given (the MCP endpoint filtering its advertised
 *  tool list). Every REST endpoint uses authenticateApiKey instead. */
export async function identifyApiKey(request: Request): Promise<ApiAuth | Response> {
  // Same reasoning as the admin gate: /v1 and /mcp are ours, not something to
  // expose on a hotel's own hostname.
  requireCanonicalHost(request);
  const header = request.headers.get("Authorization") || "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!raw || !/^(sk|ak)_(live|test)_/.test(raw)) {
    return apiError(401, "unauthorized", "Missing or malformed API key. Pass `Authorization: Bearer sk_…` (or ak_… for management endpoints).");
  }
  const hash = await hashKey(raw);
  const entry = await readJson<{ pid: string; keyId: string; mode: ApiKeyMode; scope?: ApiKeyScope }>(indexKey(hash));
  if (!entry) return apiError(401, "unauthorized", "Invalid or revoked API key.");
  // A key only opens a property that still exists. Deletion revokes keys, but
  // the registry is the source of truth — a row removed any other way (or a
  // revoke that lost a KV race) must not leave a working key behind.
  if (!(await getProperty(entry.pid))) return apiError(401, "unauthorized", "Invalid or revoked API key.");

  // Best-effort lastUsedAt stamp; never block the request on it.
  try {
    const recs = (await readJson<ApiKeyRecord[]>(keysKey(entry.pid))) ?? [];
    const rec = recs.find((r) => r.id === entry.keyId);
    if (rec && !rec.revokedAt) {
      rec.lastUsedAt = new Date().toISOString();
      await writeJson(keysKey(entry.pid), recs);
    } else if (!rec || rec.revokedAt) {
      return apiError(401, "unauthorized", "Invalid or revoked API key.");
    }
  } catch {
    /* stamping is best-effort */
  }
  return { pid: entry.pid, keyId: entry.keyId, mode: entry.mode, scope: entry.scope ?? "book" };
}
