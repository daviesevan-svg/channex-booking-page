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

const seededKey = (pid: string) => `extras_seeded:${pid}`;

/** Seed a starter set of example extras the first time a property's Extras page
 *  is opened, so owners have something to edit/delete rather than a blank page.
 *  Guarded by a one-time marker: once seeded (or if the catalog already has
 *  extras), it never seeds again — deleting all examples won't bring them back. */
export async function ensureExampleExtras(pid: string): Promise<void> {
  const kv = getConfigKV();
  if (!kv) return;
  if (await kv.get(seededKey(pid))) return;
  const existing = await getExtras(pid);
  await kv.put(seededKey(pid), "1");
  if (existing.length > 0) return; // never overwrite an owner's own extras

  const now = new Date().toISOString();
  const examples: Extra[] = [
    {
      id: crypto.randomUUID(),
      name: "Daily breakfast",
      desc: "Full breakfast served each morning of your stay.",
      unit: "night",
      price: 24,
      active: true,
      position: 0,
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: "Parking",
      desc: "Secure on-site parking for one vehicle.",
      unit: "night",
      price: 15,
      active: true,
      position: 1,
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: "Champagne on arrival",
      desc: "A chilled bottle of brut Champagne waiting in your room.",
      unit: "stay",
      price: 55,
      active: true,
      position: 2,
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: "Late checkout (2pm)",
      desc: "Keep your room until 2pm on departure day — no rush.",
      unit: "stay",
      price: 30,
      active: true,
      position: 3,
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: "Airport pickup",
      desc: "Private door-to-door transfer with meet & greet at arrivals.",
      unit: "trip",
      infoTitle: "Flight details",
      options: [
        { id: "car", name: "Private car · 1–4 guests", price: 65, desc: "Comfortable saloon, room for luggage." },
        { id: "van", name: "Private van · 5–8 guests", price: 95, desc: "Spacious minivan, ideal for groups." },
        { id: "sedan", name: "Luxury sedan · 1–3 guests", price: 120, desc: "Premium Mercedes E-Class." },
      ],
      fields: [
        { id: "flight", label: "Flight number", short: "Flight", placeholder: "e.g. EI 462", required: true },
        { id: "arrival", label: "Expected arrival time", short: "Arr", placeholder: "e.g. 14:30", required: false },
      ],
      active: true,
      position: 4,
      createdAt: now,
    },
  ];
  await writeExtras(pid, examples);
}
