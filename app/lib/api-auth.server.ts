// Public REST API authentication: per-property API keys (Stripe-style
// sk_live_/sk_test_). Keys are shown once at creation and stored only as an
// HMAC-SHA256 hash. A global reverse index maps hash → { pid, keyId } for O(1)
// auth lookup. test-mode keys force simulated bookings (no Channex push).
import { getConfig, getConfigKV } from "./config.server";

export type ApiKeyMode = "live" | "test";

/** Stored per-property (never returned raw). `hash` enables revocation; only
 *  `last4` is shown to the operator. */
export interface ApiKeyRecord {
  id: string;
  label: string;
  mode: ApiKeyMode;
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

/** Create a key. Returns the raw key ONCE (never retrievable again). */
export async function issueApiKey(pid: string, opts: { label: string; mode: ApiKeyMode }): Promise<{ key: ApiKeyView; raw: string }> {
  const raw = `sk_${opts.mode}_${randomToken()}`;
  const hash = await hashKey(raw);
  const rec: ApiKeyRecord = {
    id: randomToken(8),
    label: opts.label.trim() || "API key",
    mode: opts.mode,
    hash,
    last4: raw.slice(-4),
    createdAt: new Date().toISOString(),
  };
  const recs = (await readJson<ApiKeyRecord[]>(keysKey(pid))) ?? [];
  recs.push(rec);
  await writeJson(keysKey(pid), recs);
  await writeJson(indexKey(hash), { pid, keyId: rec.id, mode: rec.mode });
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

/** Resolve the API key on a request. Returns the auth context, or a ready-to-
 *  return JSON error Response (401). */
export async function authenticateApiKey(request: Request): Promise<ApiAuth | Response> {
  const header = request.headers.get("Authorization") || "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!raw || !/^sk_(live|test)_/.test(raw)) {
    return apiError(401, "unauthorized", "Missing or malformed API key. Pass `Authorization: Bearer sk_…`.");
  }
  const hash = await hashKey(raw);
  const entry = await readJson<{ pid: string; keyId: string; mode: ApiKeyMode }>(indexKey(hash));
  if (!entry) return apiError(401, "unauthorized", "Invalid or revoked API key.");

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
  return { pid: entry.pid, keyId: entry.keyId, mode: entry.mode };
}
