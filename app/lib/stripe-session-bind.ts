// Bind a retrieved Stripe Checkout Session to the pending booking/voucher it
// claims to pay, and fail closed on mode/amount/currency mismatch.
//
// The guest-controlled return URL carries both `ref` (our pending key) and
// `session_id` (Stripe's). Retrieving that session on the connected account
// proves the session exists and is paid — it does NOT prove it belongs to
// this pending. Without this check, a cheap completed session can be swapped
// onto an expensive pending and finalize at the cheap price (or a setup
// session can confirm a deposit stay with nothing collected).
//
// Shared by the web complete routes, the Stripe webhook, and voucher
// finalize so the three paths cannot drift.
import { toStripeMinor } from "./money";

export type SessionBindReason =
  | "unbound_session"
  | "property_mismatch"
  | "mode_mismatch"
  | "amount_mismatch"
  | "currency_mismatch";

export class SessionBindError extends Error {
  readonly reason: SessionBindReason;
  constructor(reason: SessionBindReason, message: string) {
    super(message);
    this.name = "SessionBindError";
    this.reason = reason;
  }
}

/** What a pending booking or voucher expects the Stripe session to show. */
export interface SessionBindTarget {
  ref: string;
  pid: string;
  expectedMode: "payment" | "setup";
  /** Major units. Ignored when expectedMode is setup (no charge). */
  expectedAmount: number;
  expectedCurrency: string;
}

/** The Stripe fields this check reads. Matches Checkout Session retrieve. */
export interface BindableSession {
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  mode?: string | null;
  /** Stripe minor units. */
  amount_total?: number | null;
  currency?: string | null;
}

/** Fields we stamp when creating sessions — see checkout.tsx / voucher-buy.tsx
 *  / api.v1.bookings.tsx (`metadata: { reference, pid }` and voucher `kind`). */
function sessionPid(session: BindableSession): string {
  const pid = session.metadata?.pid;
  return typeof pid === "string" ? pid : "";
}

function sessionMetaReference(session: BindableSession): string {
  const ref = session.metadata?.reference;
  return typeof ref === "string" ? ref : "";
}

/**
 * Require `session` to be the one we created for this pending. Throws
 * SessionBindError on any mismatch — callers must not finalize.
 */
export function assertSessionMatchesPending(session: BindableSession, target: SessionBindTarget): void {
  const sessionRef = typeof session.client_reference_id === "string" ? session.client_reference_id : "";
  if (!target.ref || !sessionRef || sessionRef !== target.ref) {
    throw new SessionBindError(
      "unbound_session",
      `Stripe session client_reference_id=${sessionRef || "(empty)"} does not match pending ref=${target.ref}`,
    );
  }
  // metadata.reference is stamped on every session we create; if present it
  // must agree. Missing it on a legacy session is not itself a reject — the
  // client_reference_id check above is the binding.
  const metaRef = sessionMetaReference(session);
  if (metaRef && metaRef !== target.ref) {
    throw new SessionBindError(
      "unbound_session",
      `Stripe session metadata.reference=${metaRef} does not match pending ref=${target.ref}`,
    );
  }

  const pid = sessionPid(session);
  if (!target.pid || !pid || pid !== target.pid) {
    throw new SessionBindError(
      "property_mismatch",
      `Stripe session metadata.pid=${pid || "(empty)"} does not match pending pid=${target.pid}`,
    );
  }

  const sessionMode = session.mode === "setup" || session.mode === "payment" ? session.mode : "";
  if (sessionMode !== target.expectedMode) {
    throw new SessionBindError(
      "mode_mismatch",
      `Stripe session mode=${session.mode || "(empty)"} does not match expected ${target.expectedMode} for ${target.ref}`,
    );
  }

  if (target.expectedMode === "setup") return;

  const expCur = (target.expectedCurrency || "").toUpperCase();
  const gotCur = (session.currency || "").toUpperCase();
  if (!expCur || !gotCur || expCur !== gotCur) {
    throw new SessionBindError(
      "currency_mismatch",
      `Stripe session currency=${gotCur || "(empty)"} does not match expected ${expCur || "(empty)"} for ${target.ref}`,
    );
  }

  const expectedMinor = toStripeMinor(target.expectedAmount, expCur);
  const gotMinor = session.amount_total ?? 0;
  if (expectedMinor !== gotMinor) {
    throw new SessionBindError(
      "amount_mismatch",
      `Stripe session amount=${gotMinor} ${gotCur} does not match expected ${expectedMinor} ${expCur} for ${target.ref}`,
    );
  }
}

/**
 * Last-line check on the PaymentInfo we are about to persist. Skips when
 * `payment` is missing (test-mode / no-gateway finalize). Used by
 * finalizeBooking / finalizeVoucher so a swapped PaymentInfo cannot claim
 * inventory even if a caller forgot assertSessionMatchesPending.
 */
export function assertCollectedPayment(
  payment: { mode?: string; amount?: number; currency?: string } | undefined,
  expected: { mode: "payment" | "setup"; amount: number; currency: string },
  label: string,
): void {
  if (!payment) return;
  if (payment.mode !== expected.mode) {
    throw new SessionBindError(
      "mode_mismatch",
      `Collected payment mode=${payment.mode || "(empty)"} does not match expected ${expected.mode} for ${label}`,
    );
  }
  if (expected.mode === "setup") return;

  const expCur = (expected.currency || "").toUpperCase();
  const gotCur = (payment.currency || "").toUpperCase();
  if (!expCur || !gotCur || expCur !== gotCur) {
    throw new SessionBindError(
      "currency_mismatch",
      `Collected currency=${gotCur || "(empty)"} does not match expected ${expCur || "(empty)"} for ${label}`,
    );
  }
  const expectedMinor = toStripeMinor(expected.amount, expCur);
  const gotMinor = toStripeMinor(payment.amount ?? 0, expCur);
  if (expectedMinor !== gotMinor) {
    throw new SessionBindError(
      "amount_mismatch",
      `Collected amount=${gotMinor} ${gotCur} does not match expected ${expectedMinor} ${expCur} for ${label}`,
    );
  }
}

export function bookingSessionTarget(pending: {
  pid: string;
  record: { reference: string; currency: string; consent?: { dueNow?: number } };
}): SessionBindTarget {
  const due = pending.record.consent?.dueNow ?? 0;
  return {
    ref: pending.record.reference,
    pid: pending.pid,
    expectedMode: due > 0 ? "payment" : "setup",
    expectedAmount: due,
    expectedCurrency: pending.record.currency,
  };
}

export function voucherSessionTarget(
  pending: { pid: string; record: { product: { price: number } } },
  ref: string,
  currency: string,
): SessionBindTarget {
  return {
    ref,
    pid: pending.pid,
    expectedMode: "payment",
    expectedAmount: pending.record.product.price,
    expectedCurrency: currency,
  };
}

/**
 * Refund the session only when it is bound to THIS pending (same ref) but the
 * money is wrong. An unbound session belongs to another checkout — refunding
 * it would steal that guest's payment.
 */
export function shouldRefundMismatchedSession(reason: SessionBindReason): boolean {
  return reason === "amount_mismatch" || reason === "currency_mismatch";
}

/** Pull ref + session id from a verified checkout.session.completed event.
 *  The webhook trusts Stripe's client_reference_id, never a query param. */
export function refsFromStripeCheckoutEvent(event: {
  type?: string;
  data?: { object?: Record<string, unknown> };
}): { ref: string; sessionId: string; kind: "voucher" | "booking" } | null {
  if (event.type !== "checkout.session.completed") return null;
  const s = event.data?.object ?? {};
  const ref = typeof s.client_reference_id === "string" ? s.client_reference_id : "";
  const sessionId = typeof s.id === "string" ? s.id : "";
  if (!ref || !sessionId) return null;
  const meta = (s.metadata ?? {}) as Record<string, unknown>;
  return { ref, sessionId, kind: meta.kind === "voucher" ? "voucher" : "booking" };
}
