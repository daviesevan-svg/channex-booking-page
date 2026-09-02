// Teammate invites that are waiting for the owner.
//
// The admin Team page invites directly: the person clicking is the owner (or
// the hotel's partner admin), and they can see who they are adding. The
// management API cannot make that claim — a key is not a person, and an agent
// holding one will do what its prompt says, including a prompt it read off a
// guest review. So an API invite is a REQUEST: it is parked here, the owner is
// told, and nothing happens to the team or to any user record until the owner
// approves it on the Team page. Before this, one API call minted an admin
// account that outlived the key it came from.
//
// One small per-property list, read-modify-written like the property's other
// lists (docs/management-api.md §3 accepts that for per-property data).
import { getConfigKV } from "./config.server";

export interface PendingInvite {
  email: string;
  requestedAt: string;
  via: "api";
}

const key = (pid: string) => `pending_invites:${pid}`;

export async function listPendingInvites(pid: string): Promise<PendingInvite[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(key(pid));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as PendingInvite[]) : [];
  } catch {
    return [];
  }
}

async function write(pid: string, list: PendingInvite[]): Promise<void> {
  const kv = getConfigKV();
  if (!kv) return;
  if (list.length) await kv.put(key(pid), JSON.stringify(list));
  else await kv.delete(key(pid));
}

/** Parks an invite for approval. Idempotent per email — a retried call doesn't
 *  produce a second row (or a second owner notification, see the caller). */
export async function addPendingInvite(pid: string, email: string): Promise<{ invite: PendingInvite; created: boolean }> {
  const e = email.trim().toLowerCase();
  const list = await listPendingInvites(pid);
  const existing = list.find((i) => i.email === e);
  if (existing) return { invite: existing, created: false };
  const invite: PendingInvite = { email: e, requestedAt: new Date().toISOString(), via: "api" };
  list.push(invite);
  await write(pid, list);
  return { invite, created: true };
}

/** Removes a parked invite (approved or declined). True when one was there. */
export async function removePendingInvite(pid: string, email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const list = await listPendingInvites(pid);
  const next = list.filter((i) => i.email !== e);
  if (next.length === list.length) return false;
  await write(pid, next);
  return true;
}
