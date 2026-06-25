import { getRates } from "./catalog.server";
import type { DeadlineUnit } from "./content";
import { getSettings } from "./overrides.server";

export interface CancellationSnapshot {
  refundable: boolean;
  /** Latest moment a guest may self-cancel (ISO). null = no time limit. */
  cancelByISO: string | null;
}

function deadlineMs(value?: number, unit?: DeadlineUnit): number | null {
  if (!value || value <= 0) return null;
  const hours = unit === "days" ? value * 24 : value; // default unit: hours
  return hours * 3600 * 1000;
}

/** Resolve a booking's cancellation policy from its rates' overrides, falling
 *  back to the global Customer Portal defaults. For multi-room bookings we take
 *  the most restrictive: refundable only if every rate is, and the earliest
 *  cancel-by deadline across rooms. */
export async function resolveBookingCancellation(
  pid: string,
  rateIds: string[],
  checkinISO: string,
): Promise<CancellationSnapshot> {
  const [rates, settings] = await Promise.all([getRates(pid), getSettings(pid)]);
  const byId = new Map(rates.map((r) => [r.id, r]));
  const checkinMs = Date.parse(checkinISO);

  let refundable = true;
  let earliestCancelBy: number | null = null;

  for (const id of rateIds) {
    const rate = byId.get(id);
    if (!rate) continue;
    if (rate.refundable === false) refundable = false;

    let value = rate.cancelDeadlineValue;
    let unit = rate.cancelDeadlineUnit;
    if (value == null) {
      value = settings.cancelDeadlineValue;
      unit = settings.cancelDeadlineUnit;
    }
    const ms = deadlineMs(value, unit);
    if (ms == null) continue; // this rate has no time limit
    const cancelBy = checkinMs - ms;
    earliestCancelBy = earliestCancelBy == null ? cancelBy : Math.min(earliestCancelBy, cancelBy);
  }

  return {
    refundable,
    cancelByISO:
      earliestCancelBy == null || Number.isNaN(earliestCancelBy)
        ? null
        : new Date(earliestCancelBy).toISOString(),
  };
}
