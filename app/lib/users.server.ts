// User registry for the multi-tenant admin. A "user" is just an email that has
// signed in via magic link (no passwords). Members see only the properties they
// own (see properties.server.ts); superadmins see everything and manage users.
import { getConfig, getConfigKV } from "./config.server";

export type Role = "member" | "superadmin";

export interface User {
  email: string;
  role: Role;
  createdAt: number;
}

const KEY = "users";

async function read(): Promise<User[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as User[]) : [];
  } catch {
    return [];
  }
}

async function write(list: User[]): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(KEY, JSON.stringify(list));
}

const norm = (email: string) => email.trim().toLowerCase();

export async function getUsers(): Promise<User[]> {
  return read();
}

export async function getUser(email: string): Promise<User | undefined> {
  const e = norm(email);
  return (await read()).find((u) => u.email === e);
}

/** Ensures a user record exists (created as a member). Called on every login so
 *  the Users page reflects everyone who has signed in. */
export async function upsertUser(email: string): Promise<User> {
  const e = norm(email);
  const list = await read();
  let user = list.find((u) => u.email === e);
  if (!user) {
    user = { email: e, role: "member", createdAt: Date.now() };
    list.push(user);
    await write(list);
  }
  return user;
}

export async function setUserRole(email: string, role: Role): Promise<void> {
  const e = norm(email);
  const list = await read();
  const u = list.find((x) => x.email === e);
  if (u) {
    u.role = role;
    await write(list);
  }
}

/** Removes a user record. Their properties are left in place (ownerless), so a
 *  superadmin can reassign them. */
export async function removeUser(email: string): Promise<void> {
  const e = norm(email);
  await write((await read()).filter((u) => u.email !== e));
}

/** True once any superadmin exists — via env list or a stored superadmin record. */
export async function hasAnySuperadmin(): Promise<boolean> {
  if (getConfig().superadminEmails.length > 0) return true;
  return (await read()).some((u) => u.role === "superadmin");
}

/** Effective superadmin check. No-lockout bootstrap: while NO superadmin exists
 *  anywhere, every signed-in user is treated as a superadmin (mirrors the
 *  "empty ADMIN_EMAILS = open" posture) so a fresh deploy is never locked out. */
export async function isSuperadmin(email: string): Promise<boolean> {
  const e = norm(email);
  if (getConfig().superadminEmails.includes(e)) return true;
  const list = await read();
  if (!list.some((u) => u.role === "superadmin") && getConfig().superadminEmails.length === 0) {
    return true; // bootstrap: nobody is superadmin yet
  }
  return list.some((u) => u.email === e && u.role === "superadmin");
}

/** True if this user's superadmin status comes from the env list (can't be
 *  demoted from the Users page). */
export function isEnvSuperadmin(email: string): boolean {
  return getConfig().superadminEmails.includes(norm(email));
}
