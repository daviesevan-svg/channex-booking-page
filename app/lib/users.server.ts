// User registry for the multi-tenant admin. A "user" is just an email that has
// signed in via magic link (no passwords). Members see only the properties they
// own (see properties.server.ts); superadmins see everything and manage users.
//
// Each user is stored under its OWN key (`user:{email}`) rather than in a single
// JSON blob. Cloudflare KV is eventually consistent and "concurrent writes to
// the same key … overwrite one another" — so a shared list would silently drop a
// user when two people sign in at once. Per-key writes never touch the same key,
// so concurrent sign-ins are safe. The old single-blob `users` key is migrated
// into per-key records on read (see getUsers) and then removed.
import { getConfig, getConfigKV } from "./config.server";

export type Role = "member" | "superadmin";

export interface User {
  email: string;
  role: Role;
  createdAt: number;
}

const LEGACY_KEY = "users"; // pre-migration single-blob list
const PREFIX = "user:";
const norm = (email: string) => email.trim().toLowerCase();
const userKey = (email: string) => `${PREFIX}${norm(email)}`;

function parse(raw: string | null): User | undefined {
  if (!raw) return undefined;
  try {
    const u = JSON.parse(raw);
    return u && typeof u.email === "string" ? (u as User) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the legacy single-blob list (only present until migrated away). */
async function readLegacy(): Promise<User[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(LEGACY_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as User[]) : [];
  } catch {
    return [];
  }
}

/** Lists every per-key user record. */
async function listPerKey(kv: KVNamespace): Promise<User[]> {
  const out: User[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list({ prefix: PREFIX, cursor });
    const raws = await Promise.all(res.keys.map((k) => kv.get(k.name)));
    for (const raw of raws) {
      const u = parse(raw);
      if (u) out.push(u);
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}

export async function getUsers(): Promise<User[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const map = new Map((await listPerKey(kv)).map((u) => [u.email, u]));
  // Fold any not-yet-migrated legacy users into per-key records (per-key wins).
  const legacy = await readLegacy();
  for (const u of legacy) {
    if (!map.has(u.email)) {
      map.set(u.email, u);
      await kv.put(userKey(u.email), JSON.stringify(u));
    }
  }
  // Everyone is per-key now — drop the legacy blob so it can't resurrect anyone.
  if (legacy.length) await kv.delete(LEGACY_KEY);
  return [...map.values()];
}

export async function getUser(email: string): Promise<User | undefined> {
  const kv = getConfigKV();
  if (!kv) return undefined;
  const own = parse(await kv.get(userKey(email)));
  if (own) return own;
  // Fallback for a user not yet migrated off the legacy blob.
  const e = norm(email);
  return (await readLegacy()).find((u) => u.email === e);
}

/** Ensures a user record exists (created as a member). Called on every login so
 *  the Users page reflects everyone who has signed in. */
export async function upsertUser(email: string): Promise<User> {
  const existing = await getUser(email);
  if (existing) return existing;
  const user: User = { email: norm(email), role: "member", createdAt: Date.now() };
  const kv = getConfigKV();
  if (kv) await kv.put(userKey(email), JSON.stringify(user));
  return user;
}

export async function setUserRole(email: string, role: Role): Promise<void> {
  const u = await getUser(email);
  if (!u) return;
  const kv = getConfigKV();
  if (kv) await kv.put(userKey(email), JSON.stringify({ ...u, role }));
}

/** Removes a user record. Their properties are left in place (ownerless), so a
 *  superadmin can reassign them. */
export async function removeUser(email: string): Promise<void> {
  const kv = getConfigKV();
  if (!kv) return;
  await kv.delete(userKey(email));
  // Scrub from any not-yet-migrated legacy blob so the merge can't bring them back.
  const e = norm(email);
  const legacy = await readLegacy();
  if (legacy.some((u) => u.email === e)) {
    await kv.put(LEGACY_KEY, JSON.stringify(legacy.filter((u) => u.email !== e)));
  }
}

/** Whether any stored (non-env) superadmin exists. */
async function hasStoredSuperadmin(): Promise<boolean> {
  return (await getUsers()).some((u) => u.role === "superadmin");
}

/** True once any superadmin exists — via env list or a stored superadmin record. */
export async function hasAnySuperadmin(): Promise<boolean> {
  if (getConfig().superadminEmails.length > 0) return true;
  return hasStoredSuperadmin();
}

/** Effective superadmin check. No-lockout bootstrap: while NO superadmin exists
 *  anywhere, every signed-in user is treated as a superadmin (mirrors the
 *  "empty ADMIN_EMAILS = open" posture) so a fresh deploy is never locked out. */
export async function isSuperadmin(email: string): Promise<boolean> {
  const { superadminEmails } = getConfig();
  if (superadminEmails.includes(norm(email))) return true;
  const u = await getUser(email);
  if (u?.role === "superadmin") return true;
  // Bootstrap only applies when no env superadmin is configured at all — this is
  // the only path that scans all users, and it stops once a superadmin exists.
  if (superadminEmails.length === 0 && !(await hasStoredSuperadmin())) return true;
  return false;
}

/** True if this user's superadmin status comes from the env list (can't be
 *  demoted from the Users page). */
export function isEnvSuperadmin(email: string): boolean {
  return getConfig().superadminEmails.includes(norm(email));
}
