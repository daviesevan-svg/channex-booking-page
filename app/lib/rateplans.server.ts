import { getChannexClient } from "./config.server";
import { getRoomOverrides, rateKey } from "./overrides.server";

export interface RatePlanListItem {
  /** Slug of the rate title — the mapping key and URL param. */
  key: string;
  channexTitle: string;
  /** Display names of the rooms that offer this rate. */
  rooms: string[];
  mealType?: string | null;
  cancellationTitle?: string;
}

// Channex only returns rate plans for rooms that are sellable on the queried
// dates (a dateless call returns none), and availability can be sparse. To
// discover the property's rate plans we sample several future windows and group
// them by title — so one "Breakfast Rate" entry represents every room/occupancy
// copy Channex exposes under that name.
const SCAN_OFFSETS_DAYS = [10, 24, 38, 60, 90, 120, 150, 180];
const STAY_NIGHTS = 2;

function isoPlusDays(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Discover the property's rate plans, deduped by title, with the display names
 *  of the rooms that offer each (room overrides applied). */
export async function getRatePlanList(
  propertyId: string,
  lang?: string,
): Promise<RatePlanListItem[]> {
  const client = getChannexClient();
  const roomOverrides: Record<string, { name?: string }> = await getRoomOverrides(
    propertyId,
    lang,
  ).catch(() => ({}));

  const windows = SCAN_OFFSETS_DAYS.map((off) => ({
    checkinDate: isoPlusDays(off),
    checkoutDate: isoPlusDays(off + STAY_NIGHTS),
    currency: "GBP",
  }));
  const results = await Promise.all(
    windows.map((q) => client.getRooms(propertyId, q).catch(() => [])),
  );

  const byKey = new Map<string, RatePlanListItem & { roomSet: Set<string> }>();
  for (const rooms of results) {
    for (const room of rooms) {
      const roomName = roomOverrides[room.id]?.name ?? room.title;
      for (const rp of room.ratePlans) {
        const key = rateKey(rp.title);
        let item = byKey.get(key);
        if (!item) {
          item = {
            key,
            channexTitle: rp.title,
            rooms: [],
            roomSet: new Set<string>(),
            mealType: rp.mealType,
            cancellationTitle: rp.cancellationPolicy?.title,
          };
          byKey.set(key, item);
        }
        if (!item.roomSet.has(roomName)) {
          item.roomSet.add(roomName);
          item.rooms.push(roomName);
        }
      }
    }
  }
  return [...byKey.values()].map(({ roomSet: _roomSet, ...rest }) => rest);
}
