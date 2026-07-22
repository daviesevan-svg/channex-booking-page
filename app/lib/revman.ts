// Revenue management: pure, client-safe logic (no server imports) — the
// booking → per-night explosion that feeds the rev_night table, shared by the
// server importer and testable standalone.
import type { ChannexBooking } from "./channex/pms.server";

export interface RevNightRow {
  roomSeq: number;
  stayDate: string;
  rateMinor: number;
  leadTime: number;
  los: number;
  adults: number | null;
  children: number | null;
}

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);
}

/** Booking → per-night rows. The `days` map keys are the authoritative stay
 *  dates (no arrival-offset arithmetic — the reference implementation had an
 *  off-by-one doing that). Rows for one booking are always fully replaced by
 *  the importer, so modifications that change dates or drop rooms leave no
 *  stale nights. */
export function bookingToNights(b: ChannexBooking): {
  bookingDate: string;
  isCancelled: 0 | 1;
  rows: RevNightRow[];
} {
  const bookingDate = (b.insertedAt ?? b.arrivalDate).slice(0, 10);
  const isCancelled = b.status === "cancelled" ? 1 : 0;
  const rows: RevNightRow[] = [];
  b.rooms.forEach((room, roomSeq) => {
    const dates = Object.keys(room.days)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    if (dates.length === 0) return;
    const occ = room.occupancy ?? b.occupancy;
    for (const stayDate of dates) {
      const rate = Number.parseFloat(String(room.days[stayDate]));
      rows.push({
        roomSeq,
        stayDate,
        rateMinor: Number.isFinite(rate) ? Math.round(rate * 100) : 0,
        leadTime: Math.max(0, daysBetween(bookingDate, stayDate)),
        los: dates.length,
        adults: occ?.adults ?? null,
        children: occ?.children ?? null,
      });
    }
  });
  return { bookingDate, isCancelled, rows };
}
