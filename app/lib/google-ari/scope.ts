import type { InventoryScope } from "../ari/read.server";

/** Merge changed cells; a full-window request (undefined) dominates a delta.
 * Bound durable record size: a large delta safely becomes a full reconcile. */
export function mergeAriScopes(a: InventoryScope | undefined, b: InventoryScope | undefined): InventoryScope | undefined {
  if (!a || !b) return undefined;
  const availability = new Map<string, Set<string>>();
  const products = new Map<string, { roomId: string; rateId: string; dates: Set<string> }>();
  for (const scope of [a, b]) {
    for (const c of scope.availability) {
      const dates = availability.get(c.roomId) ?? new Set<string>();
      c.dates.forEach((d) => dates.add(d));
      availability.set(c.roomId, dates);
    }
    for (const c of scope.products) {
      const key = JSON.stringify([c.roomId, c.rateId]);
      const cell = products.get(key) ?? { roomId: c.roomId, rateId: c.rateId, dates: new Set<string>() };
      c.dates.forEach((d) => cell.dates.add(d));
      products.set(key, cell);
    }
  }
  const scope = {
    availability: [...availability].map(([roomId, dates]) => ({ roomId, dates: [...dates].sort() })),
    products: [...products.values()].map((c) => ({ ...c, dates: [...c.dates].sort() })),
  };
  return JSON.stringify(scope).length > 60_000 ? undefined : scope;
}

/** Parse the same known change types as ingest; no unrelated dates/products
 * are added. Invalid or empty date intervals do not create queue work. */
export function ariScopesFromChanges(body: unknown): Map<string, InventoryScope | undefined> {
  const notes = (body as { data?: unknown })?.data;
  const out = new Map<string, InventoryScope | undefined>();
  for (const note of Array.isArray(notes) ? notes : []) {
    const attrs = note?.attributes ?? {};
    const pid = String(attrs.hotel_code ?? "");
    if (!pid) continue;
    for (const change of Array.isArray(attrs.changes) ? attrs.changes : []) {
      const a = change?.attributes ?? {};
      const availability = change?.type === "availability_changes";
      if (!availability && change?.type !== "restriction_changes") continue;
      const start = new Date(`${a.date_from}T00:00:00Z`).getTime();
      const end = new Date(`${a.date_to}T00:00:00Z`).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      // Very large pushes need no expanded queue metadata: reconciliation is
      // the bounded durable representation of the same work.
      if ((end - start) / 86_400_000 > 1000) { out.set(pid, undefined); continue; }
      const dates: string[] = [];
      for (let t = start; t <= end; t += 86_400_000) dates.push(new Date(t).toISOString().slice(0, 10));
      const delta: InventoryScope = {
        availability: availability ? [{ roomId: String(a.room_type_id ?? ""), dates }] : [],
        products: availability ? [] : [{ roomId: String(a.room_type_id ?? ""), rateId: String(a.rate_plan_id ?? ""), dates }],
      };
      out.set(pid, out.has(pid) ? mergeAriScopes(out.get(pid), delta) : mergeAriScopes(delta, delta));
    }
  }
  return out;
}
