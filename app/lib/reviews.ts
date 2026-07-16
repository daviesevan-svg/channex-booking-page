// Client-safe review types + constants (shared by the guest review page, the
// admin list and the server store in reviews.server.ts).

export const REVIEW_CATEGORIES = ["value", "clean", "location", "comfort", "facilities", "staff"] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export interface ReviewRecord {
  id: string;
  bookingId: string;
  createdAt: string;
  updatedAt: string;
  /** Overall rating, 1–5. */
  stars: number;
  /** Optional per-category ratings, 1–5 (Booking.com-style). */
  categories: Partial<Record<ReviewCategory, number>>;
  /** Public review text (shown on the property page unless hidden). */
  publicText?: string;
  /** Private note to the property — never shown publicly. */
  privateNote?: string;
  /** Guest display name (first name + last initial, from the booking). */
  guestName: string;
  /** Stay dates for context on the public display. */
  checkin: string;
  checkout: string;
  /** Hidden by the hotel — kept, but not shown publicly. */
  hidden?: boolean;
  /** The hotel's public response. */
  response?: { text: string; at: string; by?: string };
}
