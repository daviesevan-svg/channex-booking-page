import type { RoomWithRates } from "./channex/types";
import type { Occupancy } from "./occupancy";
import { partySize, roomAvailability } from "./occupancy";

// The cart lives in the URL (`sel` param) as `roomId:rateId,roomId:rateId…`,
// so it's SSR-resolvable, shareable, and survives reloads. A room may appear
// multiple times (e.g. two single rooms).
export interface CartLine {
  roomId: string;
  rateId: string;
}

export function parseCart(sp: URLSearchParams): CartLine[] {
  return (sp.get("sel") || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((tok) => {
      const [roomId, rateId] = tok.split(":");
      return roomId && rateId ? { roomId, rateId } : null;
    })
    .filter((l): l is CartLine => l !== null);
}

export function serializeCart(lines: CartLine[]): string {
  return lines.map((l) => `${l.roomId}:${l.rateId}`).join(",");
}

export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  return [...lines, line];
}

export function removeIndex(lines: CartLine[], index: number): CartLine[] {
  return lines.filter((_, i) => i !== index);
}

export interface ResolvedLine extends CartLine {
  roomTitle: string;
  rateTitle: string;
  occupancy: { adults: number; children: number; infants: number };
  total: number;
  net: number;
  photo?: string;
}

export function resolveCart(lines: CartLine[], rooms: RoomWithRates[]): ResolvedLine[] {
  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    const room = rooms.find((r) => r.id === line.roomId);
    const rate = room?.ratePlans.find((p) => p.id === line.rateId);
    if (room && rate) {
      resolved.push({
        ...line,
        roomTitle: room.title,
        rateTitle: rate.title,
        occupancy: rate.occupancy,
        total: Number(rate.totalPrice),
        net: Number(rate.netPrice ?? rate.totalPrice),
        photo: room.photos?.[0]?.url,
      });
    }
  }
  return resolved;
}

export interface CartCoverage {
  adults: number;
  children: number;
  capacity: number;
  total: number;
  net: number;
}

export function cartCoverage(resolved: ResolvedLine[]): CartCoverage {
  return resolved.reduce<CartCoverage>(
    (acc, l) => ({
      adults: acc.adults + l.occupancy.adults,
      children: acc.children + l.occupancy.children,
      capacity: acc.capacity + l.occupancy.adults + l.occupancy.children + l.occupancy.infants,
      total: acc.total + l.total,
      net: acc.net + l.net,
    }),
    { adults: 0, children: 0, capacity: 0, total: 0, net: 0 },
  );
}

/** The cart covers the party when its rooms seat at least everyone, with enough adult slots. */
export function cartCovers(resolved: ResolvedLine[], occ: Occupancy): boolean {
  const c = cartCoverage(resolved);
  return resolved.length > 0 && c.adults >= occ.adults && c.capacity >= partySize(occ);
}

/** How many of each room type the cart holds. */
export function roomCounts(lines: CartLine[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l.roomId, (counts.get(l.roomId) ?? 0) + 1);
  return counts;
}

/** No room type may be added beyond its available inventory. */
export function withinAvailability(lines: CartLine[], rooms: RoomWithRates[]): boolean {
  for (const [roomId, count] of roomCounts(lines)) {
    const room = rooms.find((r) => r.id === roomId);
    if (room && count > roomAvailability(room)) return false;
  }
  return true;
}
