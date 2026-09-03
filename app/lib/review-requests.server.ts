// Review-request emails — OTA-style: ask on the evening of the checkout day,
// then remind up to twice (3 sends total), stopping as soon as the guest leaves
// a review. Driven by the 6-hourly cron.
import { getConfig, getDB } from "./config.server";
import { getBooking, updateBooking, type BookingRecord } from "./bookings.server";
import { sendReviewRequestEmail } from "./email.server";
import { getReviewByBooking } from "./reviews.server";
import { getProperty } from "./properties.server";
import { getSettings } from "./overrides.server";
import { addDaysISO, localTimeToUtcMs } from "./dates";

/** Days after checkout each attempt is due. Three asks, then silence. */
const ATTEMPT_DAYS = [0, 3, 5];

/** A catch-up floor: never two asks inside this window. Every due time is
 *  anchored to the checkout date, so a booking that first becomes visible to the
 *  sweep days late (mail was down, a property connected mid-stay) has all three
 *  attempts already overdue — without this it would empty the whole sequence
 *  into the guest's inbox over a single day of cron ticks. Deliberately shorter
 *  than the 2-day gap between the reminders, so it never delays a booking that
 *  is running to schedule. */
const MIN_GAP_MS = 36 * 3600 * 1000;

/** When each attempt becomes due: 17:00 ("evening") in the property's timezone
 *  — falling back to UTC when unset — on the checkout day, then 3 and 5 days
 *  after it. Anchored to the checkout DATE rather than to the previous send, so
 *  the cadence stays 0/3/5 whatever time of day each cron tick happens to land;
 *  the floor above is the one thing measured from the last send. */
export function dueAt(booking: BookingRecord, tz?: string): number {
  const count = booking.reviewRequests?.count ?? 0;
  const offset = ATTEMPT_DAYS[count];
  if (offset === undefined) return Infinity; // all three asked
  const due = localTimeToUtcMs(addDaysISO(booking.checkout, offset), 17, tz);
  if (count === 0) return due;
  const last = Date.parse(booking.reviewRequests?.lastAt ?? "");
  if (Number.isNaN(last)) return Infinity;
  return Math.max(due, last + MIN_GAP_MS);
}

/** Cron entry: sweep recent checkouts and send any due review requests.
 *  Only real (confirmed, active) bookings get asked; each failure is isolated. */
export async function scheduledReviewRequests(): Promise<void> {
  const db = getDB();
  if (!db) return;
  // Recent checkouts only — beyond 21 days every booking has either had its 3
  // asks (the last is due 5 days after checkout) or is too stale to ask.
  let rows: { pid: string; id: string }[];
  try {
    const res = await db
      .prepare(
        `SELECT pid, id FROM booking
         WHERE lifecycle = 'active'
           AND json_extract(json, '$.status') = 'confirmed'
           AND json_extract(json, '$.checkout') <= date('now')
           AND json_extract(json, '$.checkout') >= date('now', '-21 day')`,
      )
      .all<{ pid: string; id: string }>();
    rows = res.results ?? [];
  } catch (e) {
    console.log(`[reviews] sweep query failed: ${e instanceof Error ? e.message : e}`);
    return;
  }

  const now = Date.now();
  for (const row of rows) {
    try {
      const booking = await getBooking(row.pid, row.id);
      if (!booking) continue;
      const count = booking.reviewRequests?.count ?? 0;
      if (count >= ATTEMPT_DAYS.length) continue;
      const settings = await getSettings(row.pid);
      if (now < dueAt(booking, settings.timezone)) continue;
      if (await getReviewByBooking(row.pid, row.id)) continue; // already reviewed

      const property = await getProperty(row.pid);
      if (!property) continue;
      const origin = getConfig().appUrl.replace(/\/+$/, "");
      const reviewUrl = `${origin}/${property.slug || row.pid}/review/${booking.id}`;
      const sent = await sendReviewRequestEmail(row.pid, booking, reviewUrl, count + 1);
      if (sent) {
        await updateBooking(row.pid, booking.id, {
          reviewRequests: { count: count + 1, lastAt: new Date().toISOString() },
        });
      }
    } catch (e) {
      console.log(`[reviews] request failed for ${row.pid}/${row.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
