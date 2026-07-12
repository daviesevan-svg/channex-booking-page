import type { RoomWithRates } from "./channex/types";
import type { Occupancy } from "./occupancy";
import { partySize, roomAvailability } from "./occupancy";

// The cart lives in the URL (`sel` param). Each line is
// `roomId:rateId[:adults[:age.age]]` — the optional occupancy lets one room be
// booked for a specific party (e.g. two singles for a business trip). Absent
// occupancy means "the searched party" (back-compat with older links). A room
// may appear multiple times. SSR-resolvable, shareable, survives reloads.
export interface CartLine {
  roomId: string;
  rateId: string;
  /** Adults in this room (absent = the searched party's adults). */
  adults?: number;
  /** Children ages in this room (absent = the searched party's children). */
  childrenAge?: number[];
}

export function parseCart(sp: URLSearchParams): CartLine[] {
  return (sp.get("sel") || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((tok): CartLine | null => {
      const [roomId, rateId, adultsRaw, childRaw] = tok.split(":");
      if (!roomId || !rateId) return null;
      const adults =
        adultsRaw != null && adultsRaw !== "" ? Math.max(1, parseInt(adultsRaw, 10) || 1) : undefined;
      const childrenAge = childRaw
        ? childRaw.split(".").map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n) && n >= 0)
        : undefined;
      return { roomId, rateId, adults, childrenAge: childrenAge?.length ? childrenAge : undefined };
    })
    .filter((l): l is CartLine => l !== null);
}

/** The effective occupancy for a cart line. A line that carries its own
 *  occupancy (adults set) is taken as-is, with an ABSENT children segment meaning
 *  "no children in this room" — NOT the searched children. Only a bare line (no
 *  occupancy at all, e.g. a legacy/deep link) falls back to the whole searched
 *  party. Treating adults and children as independent fallbacks silently re-added
 *  a searched child to a room the guest had deliberately sized for adults only
 *  (and to a room too small to hold it). */
export function lineOccupancy(line: CartLine, searched: Occupancy): Occupancy {
  return line.adults != null
    ? { adults: line.adults, childrenAge: line.childrenAge ?? [] }
    : { adults: searched.adults, childrenAge: searched.childrenAge };
}

export function serializeCart(lines: CartLine[]): string {
  return lines
    .map((l) => {
      let t = `${l.roomId}:${l.rateId}`;
      if (l.adults != null) {
        t += `:${l.adults}`;
        if (l.childrenAge?.length) t += `:${l.childrenAge.join(".")}`;
      }
      return t;
    })
    .join(",");
}

export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  return [...lines, line];
}

export function removeIndex(lines: CartLine[], index: number): CartLine[] {
  return lines.filter((_, i) => i !== index);
}

/** Replace a line in place (editing an already-selected room). */
export function replaceIndex(lines: CartLine[], index: number, line: CartLine): CartLine[] {
  if (index < 0 || index >= lines.length) return lines;
  return lines.map((l, i) => (i === index ? line : l));
}

export interface ResolvedLine extends CartLine {
  roomTitle: string;
  rateTitle: string;
  occupancy: { adults: number; children: number; infants: number };
  total: number;
  net: number;
  /** Flat cleaning fee for this room (per stay). */
  cleaningFee: number;
  photo?: string;
  /** Pre-discount total for this line (= total when no automatic offer). */
  originalTotal?: number;
  /** Automatic offer baked into `total`, for the itemised breakdown. */
  offerName?: string;
  offerPercent?: number;
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
        cleaningFee: Number(room.cleaningFee ?? 0),
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
