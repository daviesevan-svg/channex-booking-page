// KV-backed CRUD for the per-property Extras catalog. Types + pure logic live in
// extras.ts. Stored under `extras:{pid}` as an ordered Extra[].
import { getConfigKV } from "./config.server";
import type { Extra } from "./extras";

const extrasKey = (pid: string) => `extras:${pid}`;

export async function getExtras(pid: string): Promise<Extra[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(extrasKey(pid));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Extra[];
    return Array.isArray(arr) ? arr.sort((a, b) => a.position - b.position) : [];
  } catch {
    return [];
  }
}

/** Active extras only, for the guest-facing page. */
export async function getActiveExtras(pid: string): Promise<Extra[]> {
  return (await getExtras(pid)).filter((e) => e.active);
}

export async function getExtra(pid: string, id: string): Promise<Extra | undefined> {
  return (await getExtras(pid)).find((e) => e.id === id);
}

async function writeExtras(pid: string, list: Extra[]): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(extrasKey(pid), JSON.stringify(list));
}

export async function saveExtra(pid: string, extra: Extra): Promise<void> {
  const list = await getExtras(pid);
  const i = list.findIndex((e) => e.id === extra.id);
  if (i === -1) list.push(extra);
  else list[i] = extra;
  await writeExtras(pid, list);
}

export async function deleteExtra(pid: string, id: string): Promise<void> {
  const list = (await getExtras(pid)).filter((e) => e.id !== id);
  await writeExtras(pid, list);
}

export async function toggleExtra(pid: string, id: string): Promise<void> {
  const list = await getExtras(pid);
  const e = list.find((x) => x.id === id);
  if (!e) return;
  e.active = !e.active;
  await writeExtras(pid, list);
}
