// Extras ("Enhance your stay") — client-safe types and pure pricing logic. The
// KV-backed CRUD lives in extras.server.ts.
//
// An extra is either SIMPLE (one fixed unit price) or CONFIGURABLE (a list of
// options the guest picks one of). Either kind may collect info fields (e.g. a
// flight number). Prices scale by unit: per stay/trip ×1, per night ×nights,
// per person ×guests; quantity multiplies on top.

export type ExtraUnit = "stay" | "night" | "person" | "trip";

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
  active: boolean;
  position: number;
  createdAt: string;
}

export const UNIT_LABEL: Record<ExtraUnit, string> = {
  stay: "per stay",
  night: "per night",
  person: "per person",
  trip: "per trip",
};

export function isConfigurable(e: Extra): boolean {
  return Array.isArray(e.options) && e.options.length > 0;
}

/** Price multiplier for a unit over a given stay. */
export function unitMultiplier(unit: ExtraUnit, nights: number, guests: number): number {
  if (unit === "night") return Math.max(1, nights);
  if (unit === "person") return Math.max(1, guests);
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

export function parseExtras(sp: URLSearchParams): ExtraSelection[] {
  const raw = sp.get("extras");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.id === "string")
      .map((x) => ({
        id: String(x.id),
        optionId: x.optionId ? String(x.optionId) : undefined,
        qty: Math.max(1, Math.round(Number(x.qty) || 1)),
        info:
          x.info && typeof x.info === "object"
            ? Object.fromEntries(Object.entries(x.info).map(([k, v]) => [k, String(v)]))
            : undefined,
      }));
  } catch {
    return [];
  }
}

export function serializeExtras(sel: ExtraSelection[]): string {
  return sel.length ? JSON.stringify(sel) : "";
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
      });
    }
  }
  return lines;
}

export function extrasTotal(lines: ResolvedExtra[]): number {
  return round2(lines.reduce((s, l) => s + l.amount, 0));
}
