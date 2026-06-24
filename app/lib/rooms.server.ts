import type { RoomsQuery, RoomWithRates } from "./channex/types";
import { getChannexClient } from "./config.server";
import {
  getRatePlanOverrides,
  getRoomOverrides,
  mergeRatePlanOverride,
  mergeRoomOverride,
} from "./overrides.server";

/** Fetch rooms from Channex and apply per-room and per-rate-plan admin content
 *  overrides. Used by every guest-facing loader so titles/descriptions/photos
 *  and rate-plan content stay consistent. */
export async function getRoomsWithOverrides(
  propertyId: string,
  query: RoomsQuery = {},
  lang?: string,
): Promise<RoomWithRates[]> {
  const [rooms, roomOverrides, rateOverrides] = await Promise.all([
    getChannexClient()
      .getRooms(propertyId, query)
      .catch(() => [] as RoomWithRates[]),
    getRoomOverrides(propertyId, lang),
    getRatePlanOverrides(propertyId, lang),
  ]);
  return rooms.map((room) => {
    const merged = mergeRoomOverride(room, roomOverrides[room.id]);
    return {
      ...merged,
      ratePlans: merged.ratePlans.map((rp) =>
        mergeRatePlanOverride(rp, rateOverrides[rp.parentRatePlanId ?? rp.id]),
      ),
    };
  });
}
