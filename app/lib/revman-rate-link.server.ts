// Rate-derivation configuration (server): which rate plan revenue management
// actually moves for each room type, and how the room's other rate plans follow
// it. See revman-rate-link.ts for the pure model.
//
// The config is keyed on the ids that appear in our ARI store. For a
// Channex-connected property those ARE the Channex room-type and rate-plan ids
// (ARI arrives from Channex and is written through verbatim), which is what
// makes pushing prices back possible without a translation table.
import { getConfigKV } from "./config.server";
import { getInventory } from "./ari.server";
import { getRooms, getRates } from "./catalog.server";
import { cellKey, detectLink, linkFromDetection, type DetectedLink, type RateLink } from "./revman-rate-link";

export interface RateLinkConfig {
  /** roomTypeId → the rate plan revenue management moves for that room. */
  masterByRoom: Record<string, string>;
  /** `${roomId}|${rateId}` → how that rate follows its room's master. */
  links: Record<string, RateLink>;
  /** Push applied prices out to Channex. Off by default: it writes to live OTA
   *  inventory, so it's a deliberate per-property opt-in. */
  pushOnApply: boolean;
  /** Room type the others are COMPARED against on the mapping page. Reference
   *  only — room types are still priced on their own demand, so this doesn't
   *  derive anything; it just shows the hotelier the shape of their rate board. */
  referenceRoom?: string;
}

const EMPTY: RateLinkConfig = { masterByRoom: {}, links: {}, pushOnApply: false };

export async function getRateLinkConfig(pid: string): Promise<RateLinkConfig> {
  const kv = getConfigKV();
  if (!kv) return { ...EMPTY };
  const raw = await kv.get(`revlink:${pid}`);
  if (!raw) return { ...EMPTY };
  try {
    const c = JSON.parse(raw) as Partial<RateLinkConfig>;
    const links: Record<string, RateLink> = {};
    for (const [k, v] of Object.entries(c.links ?? {})) {
      const mode = v?.mode === "fixed" ? "fixed" : "percent";
      const value = Number(v?.value);
      if (Number.isFinite(value)) links[k] = { mode, value };
    }
    return {
      masterByRoom: { ...(c.masterByRoom ?? {}) },
      links,
      pushOnApply: c.pushOnApply === true,
      referenceRoom: typeof c.referenceRoom === "string" && c.referenceRoom ? c.referenceRoom : undefined,
    };
  } catch {
    return { ...EMPTY };
  }
}

async function writeConfig(pid: string, next: RateLinkConfig): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(`revlink:${pid}`, JSON.stringify(next));
}

/** Nominates (or clears, with an empty rateId) a room's master rate plan. The
 *  master can't also be a derived rate, so its own link is dropped. */
export async function setRateMaster(pid: string, roomId: string, rateId: string): Promise<void> {
  const cfg = await getRateLinkConfig(pid);
  if (!rateId) delete cfg.masterByRoom[roomId];
  else {
    cfg.masterByRoom[roomId] = rateId;
    delete cfg.links[cellKey(roomId, rateId)];
  }
  await writeConfig(pid, cfg);
}

export async function setRateLink(pid: string, roomId: string, rateId: string, link: RateLink | null): Promise<void> {
  const cfg = await getRateLinkConfig(pid);
  const key = cellKey(roomId, rateId);
  if (link === null) delete cfg.links[key];
  else cfg.links[key] = link;
  await writeConfig(pid, cfg);
}

/** Chooses the room type others are compared against on the mapping page. */
export async function setReferenceRoom(pid: string, roomId: string): Promise<void> {
  const cfg = await getRateLinkConfig(pid);
  if (!roomId) delete cfg.referenceRoom;
  else cfg.referenceRoom = roomId;
  await writeConfig(pid, cfg);
}

export async function setPushOnApply(pid: string, on: boolean): Promise<void> {
  const cfg = await getRateLinkConfig(pid);
  cfg.pushOnApply = on;
  await writeConfig(pid, cfg);
}

// ---------------------------------------------------------------------------
// Reading what's actually priced, and inferring relationships from it.

export interface AriRatePair {
  roomId: string;
  rateId: string;
  /** Dates in the window this (room, rate) carried a price on. */
  samples: number;
  /** Human labels when the local catalogue knows these ids. */
  roomName?: string;
  rateName?: string;
}

/** Every (room, rate) combination that carries prices in the window, so the UI
 *  lists what the property really sells rather than the catalogue's intent. */
export async function getAriRatePairs(pid: string, from: string, to: string): Promise<AriRatePair[]> {
  const [inventory, rooms, rates] = await Promise.all([getInventory(pid, from, to), getRooms(pid), getRates(pid)]);
  const roomNames = new Map(rooms.map((r) => [r.id, r.title]));
  const rateNames = new Map(rates.map((r) => [r.id, r.title]));

  const counts = new Map<string, number>();
  for (const [key, price] of Object.entries(inventory.prices)) {
    if (!(price > 0)) continue;
    const [roomId, rateId] = key.split("|");
    const k = cellKey(roomId, rateId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([k, samples]) => {
      const [roomId, rateId] = k.split("|");
      return { roomId, rateId, samples, roomName: roomNames.get(roomId), rateName: rateNames.get(rateId) };
    })
    .sort((a, b) => (a.roomName ?? a.roomId).localeCompare(b.roomName ?? b.roomId) || b.samples - a.samples);
}

/** Infers each non-master rate's relationship to its room's master from the
 *  prices on the books, WITHOUT saving — the caller shows them for review. */
export async function detectRateLinks(
  pid: string,
  from: string,
  to: string,
): Promise<Record<string, DetectedLink>> {
  const [inventory, cfg] = await Promise.all([getInventory(pid, from, to), getRateLinkConfig(pid)]);

  // roomId → date → rateId → price
  const byRoom = new Map<string, Map<string, Map<string, number>>>();
  for (const [key, price] of Object.entries(inventory.prices)) {
    if (!(price > 0)) continue;
    const [roomId, rateId, date] = key.split("|");
    let dates = byRoom.get(roomId);
    if (!dates) byRoom.set(roomId, (dates = new Map()));
    let cells = dates.get(date);
    if (!cells) dates.set(date, (cells = new Map()));
    cells.set(rateId, price);
  }

  const out: Record<string, DetectedLink> = {};
  for (const [roomId, dates] of byRoom) {
    const masterId = cfg.masterByRoom[roomId];
    if (!masterId) continue;
    // Collect (master, rate) pairs per rate across the window's dates.
    const pairs = new Map<string, { master: number; rate: number }[]>();
    for (const cells of dates.values()) {
      const master = cells.get(masterId);
      if (!(master && master > 0)) continue;
      for (const [rateId, price] of cells) {
        if (rateId === masterId) continue;
        const list = pairs.get(rateId) ?? [];
        list.push({ master, rate: price });
        pairs.set(rateId, list);
      }
    }
    for (const [rateId, list] of pairs) out[cellKey(roomId, rateId)] = detectLink(list);
  }
  return out;
}

/** Detects and SAVES a link for every non-master rate that doesn't have one
 *  yet (or, with `overwrite`, for all of them). Returns how many were written. */
export async function applyDetectedLinks(
  pid: string,
  from: string,
  to: string,
  opts: { overwrite?: boolean } = {},
): Promise<number> {
  const [detections, cfg] = await Promise.all([detectRateLinks(pid, from, to), getRateLinkConfig(pid)]);
  let written = 0;
  for (const [key, detection] of Object.entries(detections)) {
    if (!opts.overwrite && cfg.links[key]) continue;
    const link = linkFromDetection(detection);
    if (!link) continue;
    cfg.links[key] = link;
    written++;
  }
  if (written > 0) await writeConfig(pid, cfg);
  return written;
}

// ---------------------------------------------------------------------------
// Room-type relationships (informational).

export interface RoomRelation {
  roomId: string;
  roomName?: string;
  /** The rate the comparison used: the room's master when set, otherwise its
   *  cheapest rate that night (so a room with no master still shows up). */
  viaRateId?: string;
  viaRateName?: string;
  detected: DetectedLink;
}

/** The price used to represent a room on a date: its master rate when one is
 *  nominated, else the cheapest rate priced that night. */
function roomPriceOn(cells: Map<string, number>, masterId?: string): { rateId: string; price: number } | null {
  if (masterId) {
    const p = cells.get(masterId);
    if (p && p > 0) return { rateId: masterId, price: p };
  }
  let best: { rateId: string; price: number } | null = null;
  for (const [rateId, price] of cells) {
    if (!(price > 0)) continue;
    if (!best || price < best.price) best = { rateId, price };
  }
  return best;
}

/** How each room type's price compares to the reference room's, across the
 *  window. Purely descriptive — nothing derives from it — so a hotelier can see
 *  whether their room ladder is a consistent percentage, a consistent amount,
 *  or drifting. Returns [] when there's no reference or only one room priced. */
export async function detectRoomRelations(
  pid: string,
  from: string,
  to: string,
): Promise<{ referenceRoom?: string; referenceName?: string; relations: RoomRelation[] }> {
  const [inventory, cfg, rooms, rates] = await Promise.all([
    getInventory(pid, from, to),
    getRateLinkConfig(pid),
    getRooms(pid),
    getRates(pid),
  ]);
  const roomNames = new Map(rooms.map((r) => [r.id, r.title]));
  const rateNames = new Map(rates.map((r) => [r.id, r.title]));

  // date → roomId → rateId → price
  const byDate = new Map<string, Map<string, Map<string, number>>>();
  const roomSamples = new Map<string, number>();
  for (const [key, price] of Object.entries(inventory.prices)) {
    if (!(price > 0)) continue;
    const [roomId, rateId, date] = key.split("|");
    let byRoom = byDate.get(date);
    if (!byRoom) byDate.set(date, (byRoom = new Map()));
    let cells = byRoom.get(roomId);
    if (!cells) byRoom.set(roomId, (cells = new Map()));
    cells.set(rateId, price);
    roomSamples.set(roomId, (roomSamples.get(roomId) ?? 0) + 1);
  }
  if (roomSamples.size < 2) return { relations: [] };

  // Default the reference to the most-priced room so the page is useful before
  // anyone chooses one.
  const referenceRoom =
    cfg.referenceRoom && roomSamples.has(cfg.referenceRoom)
      ? cfg.referenceRoom
      : [...roomSamples.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const pairs = new Map<string, { master: number; rate: number }[]>();
  const via = new Map<string, string>();
  for (const byRoom of byDate.values()) {
    const refCells = byRoom.get(referenceRoom);
    if (!refCells) continue;
    const ref = roomPriceOn(refCells, cfg.masterByRoom[referenceRoom]);
    if (!ref) continue;
    for (const [roomId, cells] of byRoom) {
      if (roomId === referenceRoom) continue;
      const own = roomPriceOn(cells, cfg.masterByRoom[roomId]);
      if (!own) continue;
      const list = pairs.get(roomId) ?? [];
      list.push({ master: ref.price, rate: own.price });
      pairs.set(roomId, list);
      via.set(roomId, own.rateId);
    }
  }

  const relations: RoomRelation[] = [...pairs.entries()]
    .map(([roomId, list]) => ({
      roomId,
      roomName: roomNames.get(roomId),
      viaRateId: via.get(roomId),
      viaRateName: via.get(roomId) ? rateNames.get(via.get(roomId) as string) : undefined,
      detected: detectLink(list),
    }))
    .sort((a, b) => (a.roomName ?? a.roomId).localeCompare(b.roomName ?? b.roomId));

  return { referenceRoom, referenceName: roomNames.get(referenceRoom), relations };
}
