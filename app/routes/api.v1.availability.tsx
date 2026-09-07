import type { Route } from "./+types/api.v1.availability";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { getCatalogRooms, getRates, type GateReason } from "~/lib/catalog.server";
import { getSettings } from "~/lib/overrides.server";
import { policyMap, serializeAvailabilityRoom, serializeGateReason } from "~/lib/api-serialize";
import { availabilityInput } from "~/lib/api-availability-input";
import { taxConfigFrom } from "~/lib/pricing";

// GET /v1/availability?checkin=&checkout=&adults=&children_ages=
// Priced, bookable rooms + rates for a chosen stay (the results screen).
// Prices are always in the property's own currency (there is no conversion).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;

  const input = availabilityInput(new URL(request.url).searchParams);
  if ("error" in input) return apiError(400, "invalid_request", input.error);
  const { checkin, checkout, nights, adults, childrenAge } = input;

  // Currency is the property's own (no conversion); never a client param.
  const settings = await getSettings(auth.pid);
  const currency = settings.currency || "GBP";


  // Collect why anything was withheld, so an absent room is explained rather
  // than just missing.
  const reasons: GateReason[] = [];
  const [rooms, rates] = await Promise.all([
    getCatalogRooms(
      auth.pid,
      { checkinDate: checkin, checkoutDate: checkout, currency, adults, childrenAge },
      { gate: true, reasons },
    ),
    getRates(auth.pid),
  ]);

  const ctx = {
    nights,
    adults,
    children: childrenAge.length,
    checkin,
    taxConfig: taxConfigFrom(settings),
    policyByRateId: policyMap(rates, settings.cancelAnchorTime),
  };

  return Response.json({
    checkin,
    checkout,
    nights,
    currency,
    /** `total_price` on each rate is room-only; `total_price_all_in` is what the
     *  guest pays. Quote the all-in figure. */
    price_basis: "total_price is room-only; total_price_all_in includes taxes, fees and cleaning",
    data: rooms.map((r) => serializeAvailabilityRoom(r, ctx)),
    unavailable: reasons.map(serializeGateReason),
  });
}
