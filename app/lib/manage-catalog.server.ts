// Shared helpers for the management API's write routes. A ROUTE module may
// only export loader/action/etc. cleanly — any extra export that touches a
// *.server module drags it into the client bundle and fails the build (the
// PR460-era lesson), so cross-route helpers live here instead.
import { getRates, getRooms } from "./catalog.server";

/** The catalog's current ids, for validating price maps and exclusions. */
export async function catalogIds(pid: string): Promise<{ roomIds: Set<string>; rateIds: Set<string> }> {
  const [rooms, rates] = await Promise.all([getRooms(pid), getRates(pid)]);
  return { roomIds: new Set(rooms.map((r) => r.id)), rateIds: new Set(rates.map((r) => r.id)) };
}
