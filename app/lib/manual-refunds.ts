// Gateways whose refunds we never issue. The hotel refunds in the gateway's
// own merchant panel and then confirms it on the booking page, which records
// `payment.refund` with `manual: true`.
//
// 2C2P: its refund API needs a separate RSA key exchange that was never wired.
// iyzico: switched off on purpose (2026-09-23). Refunds go through the hotel,
// not through us. Shared by the server (refunds.server.ts, finalize) and the
// admin booking page, so it lives outside any `.server` module.
export const MANUAL_REFUND_GATEWAYS = { iyzico: "iyzico", "2c2p": "2C2P" } as const;

export type ManualRefundGateway = keyof typeof MANUAL_REFUND_GATEWAYS;

export function isManualRefundGateway(provider: string | undefined): provider is ManualRefundGateway {
  return provider != null && Object.hasOwn(MANUAL_REFUND_GATEWAYS, provider);
}

/** The gateway's display name, for "refund it in the {gateway} merchant panel". */
export function manualRefundGatewayName(provider: ManualRefundGateway): string {
  return MANUAL_REFUND_GATEWAYS[provider];
}
