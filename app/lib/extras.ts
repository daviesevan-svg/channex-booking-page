// Extras ("Enhance your stay") — client-safe types and pure pricing logic. The
// KV-backed CRUD lives in extras.server.ts.
//
// An extra is either SIMPLE (one fixed unit price) or CONFIGURABLE (a list of
// options the guest picks one of). Either kind may collect info fields (e.g. a
// flight number). Prices scale by unit: per stay/trip ×1, per night ×nights,
// per person ×guests; quantity multiplies on top.

export type ExtraUnit = "stay" | "night" | "person" | "person_night" | "trip";

/** Where an extra is offered:
 *  - "room": attaches to each room, chosen on that room's "enhance" step.
 *  - "booking": offered once for the whole stay (e.g. airport pickup). */
export type ExtraScope = "room" | "booking";

export interface ExtraOption {
  id: string;
  name: string;
  price: number;
  desc?: string;
  /** Overrides the extra's unit for this option (else inherits it). */
  unit?: ExtraUnit;
}

export interface ExtraField {
  id: string;
  label: string;
  /** Short label used in summaries (e.g. "Flight"). */
  short?: string;
  placeholder?: string;
  required: boolean;
}

export interface Extra {
  id: string;
  name: string;
  desc?: string;
  /** Default unit (simple extras, and option fallback). */
  unit: ExtraUnit;
  /** Simple extra unit price. Undefined for configurable extras. */
  price?: number;
  /** Options make the extra configurable (rendered as a popup). */
  options?: ExtraOption[];
  /** Info fields collected from the guest. */
  fields?: ExtraField[];
  /** Heading for the info-fields section in the popup. */
  infoTitle?: string;
  /** Per-room (default) or once-per-booking. Undefined = "room" (back-compat). */
  scope?: ExtraScope;
  /** VAT applies to this extra (the property's tax rate, same inclusive/on-top
   *  mode as the room). Default false — extras are untaxed unless flagged. */
  taxable?: boolean;
  /** Room type ids this extra is NOT offered for (room-scoped only). */
  excludeRooms?: string[];
  /** Rate plan ids this extra is NOT offered for (room-scoped only). */
  excludeRates?: string[];
  active: boolean;
  position: number;
  createdAt: string;
}

/** An extra's effective scope (undefined defaults to per-room). */
export function scopeOf(e: Extra): ExtraScope {
  return e.scope === "booking" ? "booking" : "room";
}

/** Whether a room-scoped extra is offered for a given room + rate plan. Booking
 *  exclusions are ignored for booking-scoped extras (offered for the whole stay). */
export function extraEligible(e: Extra, roomId: string, rateId: string): boolean {
  if (e.excludeRooms?.includes(roomId)) return false;
  if (e.excludeRates?.includes(rateId)) return false;
  return true;
}

export const UNIT_LABEL: Record<ExtraUnit, string> = {
  stay: "per stay",
  night: "per night",
  person: "per person",
  person_night: "per person/night",
  trip: "per trip",
};

export function isConfigurable(e: Extra): boolean {
  return Array.isArray(e.options) && e.options.length > 0;
}

/** Price multiplier for a unit over a given stay. */
export function unitMultiplier(unit: ExtraUnit, nights: number, guests: number): number {
  if (unit === "night") return Math.max(1, nights);
  if (unit === "person") return Math.max(1, guests);
  if (unit === "person_night") return Math.max(1, nights) * Math.max(1, guests);
  return 1; // stay, trip
}

/** The "from" price shown on a configurable extra's card (cheapest option). */
export function fromPrice(e: Extra): number {
  if (!e.options?.length) return e.price ?? 0;
  return Math.min(...e.options.map((o) => o.price));
}

// ---- guest selection (URL-encoded) ----

/** What the guest selected. Carried in the URL so it survives reloads and is
 *  re-priced server-side (only ids/qty/info travel; never client prices). */
export interface ExtraSelection {
  id: string;
  optionId?: string;
  qty: number;
  info?: Record<string, string>;
}

/** Coerce an unknown JSON value into a clean ExtraSelection[] (drops junk). */
function coerceSelections(arr: unknown): ExtraSelection[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof (x as { id?: unknown }).id === "string")
    .map((x) => ({
      id: String(x.id),
      optionId: x.optionId ? String(x.optionId) : undefined,
      qty: Math.max(1, Math.round(Number(x.qty) || 1)),
      info:
        x.info && typeof x.info === "object"
          ? Object.fromEntries(Object.entries(x.info as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined,
    }));
}

/** The whole guest extras selection: one bucket per cart line (aligned by index)
 *  plus a stay-wide bucket for booking-scoped extras. Carried in the URL `xt`
 *  param (JSON) so it survives reloads and is re-priced server-side. */
export interface ExtrasState {
  /** Per-cart-line selections, aligned to the cart's `sel` order. */
  lines: ExtraSelection[][];
  /** Booking-scoped selections (offered once for the whole stay). */
  booking: ExtraSelection[];
}

export function emptyExtrasState(): ExtrasState {
  return { lines: [], booking: [] };
}

export function parseExtrasState(sp: URLSearchParams): ExtrasState {
  const raw = sp.get("xt");
  if (!raw) return emptyExtrasState();
  try {
    const obj = JSON.parse(raw) as { l?: unknown; b?: unknown };
    const lines = Array.isArray(obj?.l) ? obj.l.map(coerceSelections) : [];
    return { lines, booking: coerceSelections(obj?.b) };
  } catch {
    return emptyExtrasState();
  }
}

export function serializeExtrasState(state: ExtrasState): string {
  const lines = state.lines.map((s) => s ?? []);
  const hasLines = lines.some((s) => s.length > 0);
  if (!hasLines && state.booking.length === 0) return "";
  // Trim trailing empty line buckets to keep the URL short.
  let end = lines.length;
  while (end > 0 && lines[end - 1].length === 0) end--;
  return JSON.stringify({ l: lines.slice(0, end), b: state.booking });
}

/** Keep the per-line buckets aligned with the cart when lines are added/removed. */
export function addExtrasLine(state: ExtrasState): ExtrasState {
  return { ...state, lines: [...state.lines, []] };
}
export function removeExtrasLine(state: ExtrasState, index: number): ExtrasState {
  return { ...state, lines: state.lines.filter((_, i) => i !== index) };
}
export function setExtrasLine(state: ExtrasState, index: number, sels: ExtraSelection[]): ExtrasState {
  const lines = state.lines.slice();
  while (lines.length <= index) lines.push([]);
  lines[index] = sels;
  return { ...state, lines };
}

// ---- server-resolved lines (priced from the catalog, snapshotted) ----

export interface ResolvedExtra {
  id: string;
  name: string;
  optionId?: string;
  optionName?: string;
  unit: ExtraUnit;
  unitPrice: number;
  qty: number;
  amount: number;
  /** One-line summary of captured info, e.g. "Flight EI 462 · Arr 14:30". */
  infoLine?: string;
  /** The room this extra is attached to (room-scoped). Undefined = whole stay. */
  roomTitle?: string;
  /** VAT applies to this line (folded into the room's VAT base at checkout). */
  taxable?: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Build an info summary line from an extra's fields and the captured values. */
function infoLineFor(extra: Extra, info?: Record<string, string>): string | undefined {
  if (!extra.fields?.length || !info) return undefined;
  const parts = extra.fields
    .map((f) => {
      const v = info[f.id]?.trim();
      return v ? `${f.short || f.label} ${v}` : null;
    })
    .filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : undefined;
}

/** Resolve a guest selection against the catalog into priced lines. Invalid or
 *  inactive selections (missing extra, configurable with no valid option) are
 *  dropped, so prices are always authoritative. */
export function resolveExtras(
  catalog: Extra[],
  selections: ExtraSelection[],
  nights: number,
  guests: number,
): ResolvedExtra[] {
  const byId = new Map(catalog.filter((e) => e.active).map((e) => [e.id, e]));
  const lines: ResolvedExtra[] = [];
  for (const sel of selections) {
    const extra = byId.get(sel.id);
    if (!extra) continue;
    const qty = Math.max(1, Math.round(sel.qty || 1));
    const infoLine = infoLineFor(extra, sel.info);
    if (isConfigurable(extra)) {
      const opt = extra.options!.find((o) => o.id === sel.optionId);
      if (!opt) continue;
      const unit = opt.unit || extra.unit;
      const unitPrice = opt.price;
      const amount = round2(unitPrice * unitMultiplier(unit, nights, guests) * qty);
      lines.push({
        id: extra.id,
        name: extra.name,
        optionId: opt.id,
        optionName: opt.name,
        unit,
        unitPrice,
        qty,
        amount,
        infoLine,
        taxable: extra.taxable,
      });
    } else {
      if (extra.price == null) continue;
      const amount = round2(extra.price * unitMultiplier(extra.unit, nights, guests) * qty);
      lines.push({
        id: extra.id,
        name: extra.name,
        unit: extra.unit,
        unitPrice: extra.price,
        qty,
        amount,
        infoLine,
        taxable: extra.taxable,
      });
    }
  }
  return lines;
}

/** Sum of extras the property's VAT applies to (folded into the VAT base). */
export function taxableExtrasTotal(lines: ResolvedExtra[]): number {
  return round2(lines.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0));
}
/** Sum of extras with no VAT (added on top of the taxed total untouched). */
export function untaxedExtrasTotal(lines: ResolvedExtra[]): number {
  return round2(lines.filter((l) => !l.taxable).reduce((s, l) => s + l.amount, 0));
}

export function extrasTotal(lines: ResolvedExtra[]): number {
  return round2(lines.reduce((s, l) => s + l.amount, 0));
}

/** Group resolved extras by the room they're attached to, preserving order.
 *  Booking-scoped extras (no roomTitle) collect under a final `undefined` group. */
export function groupExtrasByRoom(lines: ResolvedExtra[]): { roomTitle?: string; lines: ResolvedExtra[] }[] {
  const groups: { roomTitle?: string; lines: ResolvedExtra[] }[] = [];
  for (const l of lines) {
    let g = groups.find((x) => x.roomTitle === l.roomTitle);
    if (!g) {
      g = { roomTitle: l.roomTitle, lines: [] };
      groups.push(g);
    }
    g.lines.push(l);
  }
  // Keep the stay-wide group last.
  return groups.sort((a, b) => Number(a.roomTitle === undefined) - Number(b.roomTitle === undefined));
}

/** A cart line's context for pricing its attached extras. */
export interface ExtraContextLine {
  roomId: string;
  rateId: string;
  roomTitle: string;
  /** Guests in this room (adults + children) — drives "per person" extras. */
  guests: number;
}

/** Resolve the whole extras state into priced lines, authoritatively:
 *  - per-line buckets only resolve room-scoped extras eligible for that
 *    room+rate, priced against that room's guests;
 *  - the booking bucket only resolves booking-scoped extras, priced against the
 *    whole party. Each per-room line is tagged with its `roomTitle`. */
export function resolveAllExtras(
  catalog: Extra[],
  state: ExtrasState,
  lines: ExtraContextLine[],
  nights: number,
  party: number,
): ResolvedExtra[] {
  const active = catalog.filter((e) => e.active);
  const out: ResolvedExtra[] = [];
  state.lines.forEach((sels, i) => {
    const line = lines[i];
    if (!line || !sels?.length) return;
    const eligible = active.filter((e) => scopeOf(e) === "room" && extraEligible(e, line.roomId, line.rateId));
    for (const r of resolveExtras(eligible, sels, nights, line.guests)) out.push({ ...r, roomTitle: line.roomTitle });
  });
  if (state.booking?.length) {
    const eligible = active.filter((e) => scopeOf(e) === "booking");
    out.push(...resolveExtras(eligible, state.booking, nights, party));
  }
  return out;
}
