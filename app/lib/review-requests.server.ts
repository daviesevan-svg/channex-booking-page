// Review-request emails — OTA-style: ask on the evening of the checkout day,
// then remind up to twice (3 sends total, each with a different subject line),
// stopping as soon as the guest leaves a review. Driven by the 6-hourly cron.
import { getConfig, getDB } from "./config.server";
import { getBooking, updateBooking, type BookingRecord } from "./bookings.server";
import { sendReviewRequestEmail } from "./email.server";
import { getReviewByBooking } from "./reviews.server";
import { getProperty } from "./properties.server";

/** When each attempt becomes due: #1 from 17:00 UTC on the checkout day
 *  ("evening" across the European market this serves; per-property timezones
 *  can refine later), #2 three days after #1, #3 seven days after #2. */
function dueAt(booking: BookingRecord): number {
  const sent = booking.reviewRequests;
  if (!sent || sent.count === 0) return Date.parse(`${booking.checkout}T17:00:00Z`);
  const last = Date.parse(sent.lastAt);
  if (Number.isNaN(last)) return Infinity;
  return last + (sent.count === 1 ? 3 : 7) * 24 * 3600 * 1000;
}

/** Subject variants per attempt — a familiar OTA cadence: invite, nudge, last call. */
export function reviewSubject(attempt: number, hotelName: string, firstName: string): string {
  if (attempt <= 1) return `How was your stay at ${hotelName}?`;
  if (attempt === 2) return `${firstName}, share your experience at ${hotelName}`;
  return `Last chance to review your stay at ${hotelName}`;
}

/** Cron entry: sweep recent checkouts and send any due review requests.
 *  Only real (confirmed, active) bookings get asked; each failure is isolated. */
export async function scheduledReviewRequests(): Promise<void> {
  const db = getDB();
  if (!db) return;
  // Recent checkouts only — beyond 21 days every booking has either had its 3
  // asks or is too stale to ask.
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
      if (count >= 3) continue;
      if (now < dueAt(booking)) continue;
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
