import { describe, expect, it, vi } from "vitest";

import type { BookingRecord } from "./bookings.server";

// The review-request cadence decides how often a guest who has just left is
// emailed. Getting it wrong is not a rendering bug — it is three emails in a
// day to someone who did not ask for any.

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: () => {},
}));

const { dueAt } = await import("./review-requests.server");

const DAY = 24 * 3600 * 1000;
const at = (iso: string) => Date.parse(iso);

/** Only the fields the schedule reads. */
const booking = (checkout: string, sent?: { count: number; lastAt: string }): BookingRecord =>
  ({ checkout, reviewRequests: sent } as unknown as BookingRecord);

describe("review-request cadence", () => {
  it("asks on the evening of the checkout day", () => {
    expect(dueAt(booking("2026-09-10"))).toBe(at("2026-09-10T17:00:00Z"));
  });

  it("counts 3 and 5 days from CHECKOUT, not from the previous send", () => {
    // A send that lands a few hours late must not drag the rest of the sequence
    // along behind it: both reminders stay pinned to the checkout date.
    const late = { count: 1, lastAt: "2026-09-11T00:00:00.000Z" };
    expect(dueAt(booking("2026-09-10", late))).toBe(at("2026-09-13T17:00:00Z"));

    const second = { count: 2, lastAt: "2026-09-13T18:00:00.000Z" };
    expect(dueAt(booking("2026-09-10", second))).toBe(at("2026-09-15T17:00:00Z"));
  });

  it("stops after the third ask", () => {
    const done = { count: 3, lastAt: "2026-09-15T18:00:00.000Z" };
    expect(dueAt(booking("2026-09-10", done))).toBe(Infinity);
  });

  it("sends at 17:00 in the property's timezone, not 17:00 UTC", () => {
    // Bangkok is UTC+7, so the guest's evening is the middle of our afternoon.
    expect(dueAt(booking("2026-09-10"), "Asia/Bangkok")).toBe(at("2026-09-10T10:00:00Z"));
    // ...and an unknown zone falls back to UTC rather than throwing.
    expect(dueAt(booking("2026-09-10"), "Not/AZone")).toBe(at("2026-09-10T17:00:00Z"));
  });

  it("keeps a gap between asks when a whole sequence is overdue at once", () => {
    // A booking the sweep only sees days late (mail was down, property connected
    // mid-stay) has all three attempts in the past. Without the floor the guest
    // would get the lot inside a single day of cron ticks.
    const justSent = { count: 1, lastAt: "2026-09-20T00:00:00.000Z" };
    expect(dueAt(booking("2026-09-10", justSent))).toBe(at("2026-09-21T12:00:00Z"));
  });

  it("never asks again on a booking whose send record is unreadable", () => {
    // Rather than treating a corrupt timestamp as "due now" and looping.
    const broken = { count: 1, lastAt: "not-a-date" };
    expect(dueAt(booking("2026-09-10", broken))).toBe(Infinity);
  });
});
