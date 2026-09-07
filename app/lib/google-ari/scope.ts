import type { InventoryScope } from "../ari/read.server";

/** Largest scope the durable queue will carry. Above it the delta is dropped
 * in favour of a full-window reconcile, which is the bounded representation
 * of the same work — and cheaper than expanding thousands of dates per cell. */
const SCOPE_MAX_JSON = 60_000;

/** Canonical form of a scope: cells merged, dates deduplicated and sorted,
 * and `undefined` when it is too large to persist. The single place the
 * size rule lives; applyChanges hands its per-webhook scopes through here. */
export function boundAriScope(...scopes: InventoryScope[]): InventoryScope | undefined {
  const availability = new Map<string, Set<string>>();
  const products = new Map<string, { roomId: string; rateId: string; dates: Set<string> }>();
  for (const scope of scopes) {
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
  return JSON.stringify(scope).length > SCOPE_MAX_JSON ? undefined : scope;
}

/** Merge changed cells; a full-window request (undefined) dominates a delta. */
export function mergeAriScopes(a: InventoryScope | undefined, b: InventoryScope | undefined): InventoryScope | undefined {
  if (!a || !b) return undefined;
  return boundAriScope(a, b);
}

