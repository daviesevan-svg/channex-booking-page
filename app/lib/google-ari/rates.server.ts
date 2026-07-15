// Builds the ARI payloads Google needs — rates, availability/restrictions,
// inventory counts and taxes — from our catalog + D1 ARI + tax settings.
//
// Pricing rule: we push the BASE rack rate only (never a discounted price).
// Discounts are all pushed separately as Google Promotions (see
// promotions.server.ts), so Google applies them on top without double-counting.
// Per-occupancy amounts come from our own occupancy pricing so Google's price
// matches the site's for the same party.
import { addDays, format, parseISO } from "date-fns";

import { getInventory } from "../ari.server";
import { getRates, getRooms, rateChannexId } from "../catalog.server";
import type { SiteSettings } from "../content";
import { getSettings } from "../overrides.server";
import { cityTaxNightlyAmount } from "../pricing";
import { occupancyNightlyDelta } from "../rate-pricing";
import type { AvailEntry, InvEntry, RateEntry, TaxLine } from "./xml";

export interface AriWindow {
  from: string;
  to: string;
}

/** [today, today + days] inclusive, as YYYY-MM-DD. */
export function ariWindow(days: number, today = new Date()): AriWindow {
  const base = format(today, "yyyy-MM-dd");
  return { from: base, to: format(addDays(parseISO(base), Math.max(1, days)), "yyyy-MM-dd") };
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const end = parseISO(to);
  for (let d = parseISO(from); d <= end; d = addDays(d, 1)) out.push(format(d, "yyyy-MM-dd"));
  return out;
}

/** Collapse a date list into maximal runs of equal value (by `eq`). */
function groupRuns<T>(
  dates: string[],
  valueAt: (date: string) => T,
  eq: (a: T, b: T) => boolean,
): { start: string; end: string; value: T }[] {
  const runs: { start: string; end: string; value: T }[] = [];
  for (const date of dates) {
    const value = valueAt(date);
    const last = runs[runs.length - 1];
    if (last && eq(last.value, value)) last.end = date;
    else runs.push({ start: date, end: date, value });
  }
  return runs;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The property's total VAT rate as a fraction (e.g. 0.2 for 20%). */
function vatRate(settings: SiteSettings): number {
  return (settings.taxes ?? []).reduce((s, t) => s + (t.rate || 0), 0) / 100;
}

/** Net (ex-VAT) and gross (VAT-inclusive) nightly amounts for a base + occupancy
 *  delta. In inclusive mode the base already contains VAT (carve it out for net);
 *  in on-top mode the base is net (add VAT for gross). We push both to Google so
 *  it shows the VAT-inclusive price rather than adding VAT on top. */
function netGross(base: number, delta: number, vat: number, inclusive: boolean): { net: number; gross: number } {
  const priced = Math.max(0, base + delta);
  const net = round2(inclusive && vat > 0 ? priced / (1 + vat) : priced);
  const gross = round2(net * (1 + vat));
  return { net, gross };
}

/** Everything needed for the four ARI messages, computed from one inventory read. */
export interface AriPayload {
  rates: RateEntry[];
  avail: AvailEntry[];
  inventory: InvEntry[];
}

export async function collectAri(pid: string, window: AriWindow): Promise<AriPayload> {
  const [rooms, allRates, settings, inv] = await Promise.all([
    getRooms(pid),
    getRates(pid),
    getSettings(pid),
    getInventory(pid, window.from, window.to),
  ]);
  const currency = settings.currency || "GBP";
  const vat = vatRate(settings);
  const inclusive = settings.taxesInclusive === true;
  const dates = eachDate(window.from, window.to);
  const activeRates = allRates.filter((r) => r.active);

  const rates: RateEntry[] = [];
  const avail: AvailEntry[] = [];
  const inventory: InvEntry[] = [];

  for (const room of rooms) {
    const maxAdults = Math.max(1, room.maxAdults || 1);
    const roomRates = activeRates.filter((r) => r.prices[room.id] !== undefined);
    if (roomRates.length === 0) continue;

    // Inventory is per room type (not per rate).
    for (const run of groupRuns(
      dates,
      (d) => inv.availability[`${room.id}|${d}`] ?? 0,
      (a, b) => a === b,
    )) {
      inventory.push({ roomId: room.id, start: run.start, end: run.end, count: run.value });
    }

    for (const rate of roomRates) {
      const op = rate.occupancyPricingByRoom?.[room.id] ?? rate.occupancyPricing;
      const catalogBase = rate.prices[room.id];
      // ARI (and Google) key by the room's real Channex rate id, which differs
      // from our single `rate.id` for a consolidated imported rate.
      const rid = rateChannexId(rate, room.id);

      // Per-occupancy nightly amounts (net + VAT-inclusive) for a given date.
      const amountsAt = (date: string): { guests: number; net: number; gross: number }[] => {
        const base = inv.prices[`${room.id}|${rid}|${date}`] ?? catalogBase;
        return Array.from({ length: maxAdults }, (_, i) => {
          const guests = i + 1;
          return { guests, ...netGross(base, occupancyNightlyDelta(op, guests, []), vat, inclusive) };
        });
      };
      const sameAmounts = (
        a: { guests: number; net: number; gross: number }[],
        b: { guests: number; net: number; gross: number }[],
      ) => a.length === b.length && a.every((x, i) => x.net === b[i].net && x.gross === b[i].gross);
      for (const run of groupRuns(dates, amountsAt, sameAmounts)) {
        rates.push({ roomId: room.id, rateId: rid, start: run.start, end: run.end, currency, amounts: run.value });
      }

      // Restrictions (authoritative open/close each push).
      const cellAt = (date: string) => {
        const c = inv.restrictions[`${room.id}|${rid}|${date}`];
        return {
          stopSell: c?.stopSell ?? false,
          cta: c?.cta ?? false,
          ctd: c?.ctd ?? false,
          minStay: Math.max(1, c?.minStay || 1),
        };
      };
      const sameCell = (a: ReturnType<typeof cellAt>, b: ReturnType<typeof cellAt>) =>
        a.stopSell === b.stopSell && a.cta === b.cta && a.ctd === b.ctd && a.minStay === b.minStay;
      for (const run of groupRuns(dates, cellAt, sameCell)) {
        avail.push({ roomId: room.id, rateId: rate.id, start: run.start, end: run.end, ...run.value });
      }
    }
  }

  return { rates, avail, inventory };
}

/** Map our fee/city-tax settings to Google TaxFeeInfo lines. VAT is NOT sent as a
 *  tax here — it's folded into the rate's AmountAfterTax (so Google shows a
 *  VAT-inclusive room price instead of adding it on top). Only genuinely-extra
 *  charges ride here as fee lines: fees + city tax + cleaning (the site adds
 *  these at checkout too).
 *
 *  Because we send no VAT tax line, Google won't add VAT to these fees — so we
 *  pre-compute it: a fee that the site marks taxable is pushed VAT-INCLUSIVE
 *  (fixed amount × (1+VAT); a percent fee has its rate grossed up so Google's
 *  percent-of-room still lands on the VAT-inclusive figure). Cleaning always
 *  carries VAT. Non-taxable fees are pushed as-is. `rooms` supplies each room's
 *  (pre-VAT) cleaning fee — pushed as a per-room-scoped fee via <RoomTypes>, so
 *  rooms with different cleaning fees are each represented correctly. */
export function googleTaxLines(
  settings: SiteSettings,
  rooms: { id: string; cleaningFee?: number }[] = [],
): { taxes: TaxLine[]; fees: TaxLine[] } {
  const currency = settings.currency || "GBP";
  const vat = vatRate(settings);
  const gross = (n: number) => round2(n * (1 + vat));
  // VAT is carried in the rate (AmountAfterTax), never as an additive tax line.
  const taxes: TaxLine[] = [];

  const fees: TaxLine[] = (settings.fees ?? [])
    .filter((f) => (f.amount || 0) > 0)
    .map((f) =>
      f.kind === "percent"
        ? { type: "percent", basis: "room", period: "stay", amount: f.taxable ? gross(f.amount) : f.amount }
        : { type: "amount", basis: "room", period: "stay", amount: f.taxable ? gross(f.amount) : f.amount, currency },
    );

  // Cleaning fee — per room, per stay, always VAT-applicable on the site. Scoped
  // to its room type so differing per-room cleaning fees are each correct.
  for (const room of rooms) {
    const clean = Math.round((room.cleaningFee ?? 0) * 100) / 100;
    if (clean > 0) {
      fees.push({ type: "amount", basis: "room", period: "stay", amount: gross(clean), currency, roomIds: [room.id] });
    }
  }

  const ct = settings.cityTax;
  if (ct?.enabled) {
    // TaxFeeInfo can't express date-varying fees, so a seasonal city tax pushes
    // the CURRENTLY applicable season's rate. The 6-hourly taxes sync re-pushes
    // it, so the fee flips with the season; only stays spanning a boundary
    // compose slightly differently on Google than at checkout.
    const nightly = cityTaxNightlyAmount(ct, new Date().toISOString().slice(0, 10));
    if (nightly > 0) {
      fees.push({
        type: "amount",
        basis: ct.basis === "person_night" ? "person" : "room",
        period: ct.basis === "room_stay" ? "stay" : "night",
        amount: ct.taxable ? gross(nightly) : nightly,
        currency,
      });
    }
  }
  return { taxes, fees };
}
