// Shared (client-safe) view logic for a booking's cancellation snapshot.
// Structurally matches CancellationSnapshot from policy.server.ts.
export interface CancellationLike {
  refundable: boolean;
  cancelByISO: string | null;
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
  | { key: "freeCancellationUntil" | "freeCancellationEnded"; iso: string };

export function cancellationMessage(
  c: CancellationLike | undefined,
  nowMs: number,
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
      return { key: v.passed ? "freeCancellationEnded" : "freeCancellationUntil", iso: v.iso };
  }
}
