import type { RoomsQuery, RoomWithRates } from "./channex/types";
import { getChannexClient } from "./config.server";
import { getRoomOverrides, mergeRoomOverride } from "./overrides.server";

/** Fetch rooms from Channex and apply per-room admin content overrides.
 *  Used by every guest-facing loader so titles/descriptions/photos are consistent. */
export async function getRoomsWithOverrides(
  propertyId: string,
  query: RoomsQuery = {},
): Promise<RoomWithRates[]> {
  const [rooms, overrides] = await Promise.all([
    getChannexClient()
      .getRooms(propertyId, query)
      .catch(() => [] as RoomWithRates[]),
    getRoomOverrides(propertyId),
  ]);
  return rooms.map((room) => mergeRoomOverride(room, overrides[room.id]));
}
