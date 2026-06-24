import { getChannexClient } from "./config.server";
import { getRoomOverrides } from "./overrides.server";

export interface RatePlanListItem {
  /** Parent (logical) rate-plan id — the mapping key for content overrides. */
  id: string;
  channexTitle: string;
  roomId: string;
  roomTitle: string;
  mealType?: string | null;
  cancellationTitle?: string;
}

// Channex only returns rate plans for rooms that are sellable on the queried
// dates (a dateless call returns none), and availability can be sparse. To
// discover the property's rate plans we sample several future windows and union
// the results by parent rate-plan id.
const SCAN_OFFSETS_DAYS = [10, 24, 38, 60, 90, 120, 150, 180];
const STAY_NIGHTS = 2;

function isoPlusDays(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Discover the property's rate plans (deduped by parent id), with the owning
 *  room's display name (room overrides applied). */
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

  const byId = new Map<string, RatePlanListItem>();
  for (const rooms of results) {
    for (const room of rooms) {
      for (const rp of room.ratePlans) {
        const id = rp.parentRatePlanId ?? rp.id;
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          channexTitle: rp.title,
          roomId: room.id,
          roomTitle: roomOverrides[room.id]?.name ?? room.title,
          mealType: rp.mealType,
          cancellationTitle: rp.cancellationPolicy?.title,
        });
      }
    }
  }
  return [...byId.values()];
}
