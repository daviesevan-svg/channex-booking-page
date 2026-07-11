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

/** VAT fraction (e.g. 0.2) used to carve tax out of inclusive prices. */
function vatFraction(settings: SiteSettings): number {
  if (!settings.taxesInclusive) return 0; // prices already net; nothing to carve
  const pct = (settings.taxes ?? []).reduce((s, t) => s + (t.rate || 0), 0);
  return pct / 100;
}

/** Net (pre-tax) nightly amount for a gross base + occupancy delta. */
function netAmount(base: number, delta: number, vat: number): number {
  const gross = Math.max(0, base + delta);
  return round2(vat > 0 ? gross / (1 + vat) : gross);
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
  const vat = vatFraction(settings);
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

      // Per-occupancy nightly amount vector for a given date.
      const amountsAt = (date: string): { guests: number; amount: number }[] => {
        const base = inv.prices[`${room.id}|${rid}|${date}`] ?? catalogBase;
        return Array.from({ length: maxAdults }, (_, i) => {
          const guests = i + 1;
          return { guests, amount: netAmount(base, occupancyNightlyDelta(op, guests, []), vat) };
        });
      };
      const sameAmounts = (a: { guests: number; amount: number }[], b: { guests: number; amount: number }[]) =>
        a.length === b.length && a.every((x, i) => x.amount === b[i].amount);
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

/** Map our tax/fee/city-tax settings to Google TaxFeeInfo lines. VAT → percent
 *  taxes on the room; fees + city tax → fee lines. (The "VAT applies on top of a
 *  fee" flag isn't modelled in v1 — fees/city tax are pushed without compounding
 *  VAT; verify against staging before relying on it.) */
export function googleTaxLines(settings: SiteSettings): { taxes: TaxLine[]; fees: TaxLine[] } {
  const currency = settings.currency || "GBP";
  const taxes: TaxLine[] = (settings.taxes ?? [])
    .filter((t) => (t.rate || 0) > 0)
    .map((t) => ({ type: "percent", basis: "room", period: "stay", amount: t.rate }));

  const fees: TaxLine[] = (settings.fees ?? [])
    .filter((f) => (f.amount || 0) > 0)
    .map((f) =>
      f.kind === "percent"
        ? { type: "percent", basis: "room", period: "stay", amount: f.amount }
        : { type: "amount", basis: "room", period: "stay", amount: f.amount, currency },
    );

  const ct = settings.cityTax;
  if (ct?.enabled && ct.amount > 0) {
    fees.push({
      type: "amount",
      basis: ct.basis === "person_night" ? "person" : "room",
      period: ct.basis === "room_stay" ? "stay" : "night",
      amount: ct.amount,
      currency,
    });
  }
  return { taxes, fees };
}
