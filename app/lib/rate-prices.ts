/** The rate editor's per-room price boxes → the rate's `prices` map.
 *
 *  A room is offered this rate only when its box has a value:
 *  - blank            → not offered on this room
 *  - a positive price → that base nightly price (date-level ARI still wins)
 *  - 0                → offered, priced ONLY from ARI (the channel manager or
 *                       the inventory grid). It is what a Channex import stores
 *                       (onboard-channex), and a night with no ARI price stays
 *                       closed — 0 never sells a free room (see getCatalogRooms
 *                       and the calendar's `<= 0` check).
 *
 *  Rejecting 0 here used to make every save of an imported rate fail with
 *  "Enter a nightly price for at least one room". */
export function parseRoomPrices(
  get: (name: string) => FormDataEntryValue | null,
  roomIds: readonly string[],
): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const id of roomIds) {
    const raw = get(`price:${id}`);
    if (raw == null || String(raw).trim() === "") continue;
    const p = Math.round(Number(raw) * 100) / 100;
    if (Number.isFinite(p) && p >= 0) prices[id] = p;
  }
  return prices;
}
