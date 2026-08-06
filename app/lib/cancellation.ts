// Shared (client-safe) view logic for a booking's cancellation snapshot.
// Structurally matches CancellationSnapshot from policy.server.ts.
import { format, parseISO, type Locale } from "date-fns";

export interface CancellationLike {
  refundable: boolean;
  cancelByISO: string | null;
  /**
   * The deadline as the hotel's own wall clock, e.g. "2026-08-09T18:00" — naive,
   * no offset, so every renderer shows the time the hotel means rather than its
   * UTC equivalent (and the server and browser can't disagree on hydration).
   *
   * Optional because bookings snapshotted before deadlines were anchored have
   * only the instant; those keep rendering from `cancelByISO`.
   */
  cancelByLocal?: string;
}

export type CancelView =
  | { kind: "none" }
  | { kind: "nonRefundable" }
  | { kind: "freeAnytime" }
  | { kind: "freeUntil"; iso: string; passed: boolean };

export function cancellationView(
  c: CancellationLike | undefined,
  nowMs: number,
): CancelView {
  if (!c) return { kind: "none" };
  if (c.refundable === false) return { kind: "nonRefundable" };
  if (!c.cancelByISO) return { kind: "freeAnytime" };
  return { kind: "freeUntil", iso: c.cancelByISO, passed: nowMs > Date.parse(c.cancelByISO) };
}

/** The i18n key (and any date) for a booking's cancellation-policy line, or null
 *  when there's nothing to show. Both the guest portal and admin render this —
 *  the guest with its locale translator, admin with the English one. */
export type CancelMessage =
  | { key: "nonRefundableBooking" }
  | { key: "freeCancellationAnytime" }
  | {
      key: "freeCancellationUntil" | "freeCancellationEnded";
      iso: string;
      /** Prefer this when present — see CancellationLike.cancelByLocal. */
      local?: string;
    };

/**
 * The deadline as a guest-facing string, e.g. "Sun 9 Aug 2026, 18:00".
 *
 * One helper for all six places that render it (checkout, rate card, manage
 * booking, admin, email, PDF), because they used four different patterns between
 * them and only two showed a time — which is fine for a midnight-ish deadline and
 * actively misleading for "6pm on the day you arrive".
 *
 * With `local` present nothing is timezone-converted: the date is formatted from
 * the naive date part and the time is the hotel's own wall clock, printed as it
 * was typed. Without it (bookings snapshotted before deadlines were anchored) it
 * falls back to formatting the instant, exactly as before.
 */
export function formatCancelDeadline(
  m: { iso: string; local?: string },
  datePattern: string,
  locale?: Locale,
): string {
  if (m.local) {
    const [datePart, timePart] = m.local.split("T");
    const d = parseISO(datePart);
    if (!Number.isNaN(d.getTime()) && timePart) {
      return `${format(d, datePattern, locale ? { locale } : undefined)}, ${timePart}`;
    }
  }
  const at = parseISO(m.iso);
  return Number.isNaN(at.getTime()) ? m.iso : format(at, datePattern, locale ? { locale } : undefined);
}

export function cancellationMessage(
  c: CancellationLike | undefined,
  nowMs: number,
  opts?: { atBooking?: boolean },
): CancelMessage | null {
  const v = cancellationView(c, nowMs);
  switch (v.kind) {
    case "none":
      return null;
    case "nonRefundable":
      return { key: "nonRefundableBooking" };
    case "freeAnytime":
      return { key: "freeCancellationAnytime" };
    case "freeUntil":
      // At checkout, a free-cancellation window that has already closed means the
      // booking is non-refundable from the outset — the guest can't cancel free.
      // ("Free cancellation was available until <past date>" only makes sense when
      //  looking back at an existing booking, not while making one.)
      if (v.passed) {
        return opts?.atBooking
          ? { key: "nonRefundableBooking" }
          : { key: "freeCancellationEnded", iso: v.iso, local: c?.cancelByLocal };
      }
      return { key: "freeCancellationUntil", iso: v.iso, local: c?.cancelByLocal };
  }
}
