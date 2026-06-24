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
