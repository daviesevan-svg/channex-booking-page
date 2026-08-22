// Payment routing for POST /v1/bookings (and MCP create_booking, which
// dispatches to the same action).
//
// Hosted checkout already refuses to open Stripe/Viva unless the stay will be
// pushed live (`checkout.tsx` `goesToGateway`). The API used to charge whenever
// a gateway was connected — including for test keys and for properties with
// live bookings off — then finalize as `simulated` with no Channex push.
// That takes real money (and real cards, in Stripe setup mode) for a stay
// that is never created. This helper is the one decision both the route and
// the tests pin, so the two cannot drift.

export type ApiChargePath = "stripe" | "viva" | "uncarded" | "not_configured";

export function apiBookingChargePath(input: {
  /** Same `live` flag already computed for the Channex push: live API key AND
   *  the property has live bookings on AND Channex is the connected system. */
  live: boolean;
  due: number;
  gatewayKind: "stripe" | "viva" | undefined;
}): ApiChargePath {
  // Simulated bookings never charge — same rule as the hosted checkout.
  if (!input.live) return "uncarded";
  if (input.due > 0 && !input.gatewayKind) return "not_configured";
  if (input.gatewayKind === "viva" && input.due > 0) return "viva";
  if (input.gatewayKind === "stripe") return "stripe";
  return "uncarded";
}
