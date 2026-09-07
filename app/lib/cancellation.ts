// Shared (client-safe) view logic for a booking's cancellation snapshot.
// Structurally matches CancellationSnapshot from policy.server.ts.
import { format, parseISO, type Locale } from "date-fns";

import type { PenaltyType } from "./rate-policy";

/** One step of a cancellation schedule: cancel before `untilISO` and this is
 *  what it costs. Most generous first; the last runs to arrival. See
 *  cancel-bands.ts and docs/cancellation-tiers.md §3.1. */
export interface CancelBand {
  /** null = this band runs to arrival. */
  untilISO: string | null;
  /** The same moment as the hotel's wall clock — see `cancelByLocal`. */
  untilLocal?: string;
  penalty: PenaltyType;
  /** Percent (0–100) or a fixed amount, for penalty = percent / fixed. */
  penaltyValue?: number;
  /** The penalty in major units against the stay total. Present on a booking's
   *  snapshot (the stay is known); absent on the checkout preview. */
  penaltyAmount?: number;
}

export interface CancellationLike {
  refundable: boolean;
  /** The end of the free window — `bands[0].untilISO` when bands are present. */
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
  /**
   * The whole schedule, when the policy has more than a free window. Absent on
   * bookings made before multi-tier shipped — those were one free band ending
   * at `cancelByISO`, then nothing, and every reader still treats them so.
   */
  bands?: CancelBand[];
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

/** Whether, at `nowMs`, the schedule is in a band that refunds something but not
 *  everything. Mirrors cancel-bands' bandAt/isPartialBand, inlined so this file
 *  stays free of that module (which imports its types from here). */
function inPartialBand(c: CancellationLike | undefined, nowMs: number): boolean {
  const band = c?.bands?.find((b) => b.untilISO === null || nowMs <= Date.parse(b.untilISO));
  if (!band) return false;
  if (band.penalty === "none" || band.penalty === "full_stay") return false;
  return !(band.penalty === "percent" && (band.penaltyValue ?? 0) >= 100);
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
        if (opts?.atBooking) {
          // …unless the schedule still has a paying band open: then the booking
          // is not non-refundable, it is "cancel by X for a partial refund", and
          // the band lines say exactly that. No lead line in that case.
          return inPartialBand(c, nowMs) ? null : { key: "nonRefundableBooking" };
        }
        return { key: "freeCancellationEnded", iso: v.iso, local: c?.cancelByLocal };
      }
      return { key: "freeCancellationUntil", iso: v.iso, local: c?.cancelByLocal };
  }
}

// ---- band lines (multi-tier) ----

/** The extra lines under the lead cancellation line when the schedule has more
 *  than one step: "Until {date}, {penalty} is charged" per band still ahead, and
 *  "After that, {penalty} is charged" for the last. `penalty` is rendered by the
 *  caller with `penaltyText`, which needs its translator and currency. */
export type BandMessage =
  | { key: "cancelBandUntil"; iso: string; local?: string; penalty: PenaltyType; penaltyValue?: number }
  | { key: "afterDeadlineCharge"; penalty: PenaltyType; penaltyValue?: number };

/**
 * Lines for the bands after the free one.
 *
 * Only a schedule with an intermediate band gets them by default: a single-tier
 * booking reads exactly as it always has on the manage page, the email and the
 * PDF. Checkout passes `alwaysFinal` because it has always shown the
 * after-the-deadline charge there.
 *
 * Bands already behind us are history and are not listed; the closing "after
 * that" line only appears while there is still a "that" ahead.
 */
export function cancellationBandMessages(
  c: CancellationLike | undefined,
  nowMs: number,
  opts?: { alwaysFinal?: boolean },
): BandMessage[] {
  const bands = c?.bands;
  if (!c?.refundable || !bands || bands.length < 2) return [];
  const last = bands[bands.length - 1];
  const intermediate = bands.slice(1, -1);
  const out: BandMessage[] = [];
  for (const b of intermediate) {
    if (b.untilISO && nowMs <= Date.parse(b.untilISO)) {
      out.push({ key: "cancelBandUntil", iso: b.untilISO, local: b.untilLocal, penalty: b.penalty, penaltyValue: b.penaltyValue });
    }
  }
  const somethingAhead = bands.slice(0, -1).some((b) => b.untilISO && nowMs <= Date.parse(b.untilISO));
  if ((opts?.alwaysFinal || intermediate.length > 0) && somethingAhead && last.penalty !== "none") {
    out.push({ key: "afterDeadlineCharge", penalty: last.penalty, penaltyValue: last.penaltyValue });
  }
  return out;
}

/** A penalty in the guest's words, from the keys every locale already carries.
 *  `money` formats a fixed amount in the booking's currency. */
export function penaltyText(
  penalty: PenaltyType,
  value: number | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
  money: (amount: number) => string,
): string {
  switch (penalty) {
    case "first_night":
      return t("penaltyFirstNight");
    case "full_stay":
      return t("penaltyFullStay");
    case "percent":
      return value ? t("penaltyPercent", { n: value }) : "";
    case "fixed":
      return value ? money(value) : "";
    default:
      return "";
  }
}
