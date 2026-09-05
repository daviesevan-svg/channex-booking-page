// Whether a property may still change its currency.
//
// The guest is charged in the GATEWAY's currency, not the property's. Viva's
// order body carries no currency at all — the merchant account decides — while
// `assertCollectedPayment` compares the amount against the property's. When the
// two disagree the charge is taken and the booking is rejected; the finalize
// tripwire now refunds it, but the guest still ends up paid-and-unbooked and
// sent back to try again.
//
// Connecting a gateway checks the currency once (VIVA_CURRENCIES). Nothing
// stopped the currency changing afterwards, which is the only way that mismatch
// can be created on a property that was set up correctly. So the rule is simply:
// pick the currency before you connect, or disconnect to change it.
//
// Pure so both doors enforce the same thing — the admin form and
// PATCH /v1/manage/property — rather than one of them growing its own version.

export interface CurrencyLock {
  locked: boolean;
  /** Gateway holding the lock, for the message. */
  gateway?: string;
}

const LABEL: Record<string, string> = {
  stripe: "Stripe",
  viva: "Viva",
  iyzico: "iyzico",
};

export function currencyLock(gatewayKind: string | null | undefined): CurrencyLock {
  return gatewayKind ? { locked: true, gateway: LABEL[gatewayKind] ?? gatewayKind } : { locked: false };
}

/**
 * Whether this save is actually trying to change the currency.
 *
 * A form posts every field back, so the common case is the SAME currency
 * arriving on every save — that must not be refused, or a connected property
 * could never edit anything else on the page.
 */
export function currencyChanged(current: string | undefined, next: string | undefined): boolean {
  const norm = (v: string | undefined) => (v ?? "").trim().toUpperCase();
  const a = norm(current);
  const b = norm(next);
  return !!b && !!a && a !== b;
}

export function currencyLockMessage(lock: CurrencyLock): string {
  return `The currency can't be changed while ${lock.gateway} is connected — the guest is charged in the gateway's currency, so the two must match. Disconnect the gateway first, change the currency, then reconnect.`;
}
