// Google's hotel price-accuracy crawler: navigation tags and price microdata.
// https://developers.google.com/hotels/hotel-prices/structured-data/generic-crawler-guide
//
// Google now validates our advertised prices by DRIVING the funnel rather than
// only reading the JSON-LD: a headless crawler lands on a dated page, clicks
// whatever we mark as the critical path until it reaches the last page before
// payment, and reads the stay total off that page as visible HTML microdata.
//
// Both halves stay. The JSON-LD in hotel-jsonld.server.ts still feeds Free
// Booking Links; these attributes feed price validation. Google has published
// no JSON-LD sunset date, so nothing there is being retired on the strength of
// an email.
//
// The attribute names live here rather than as literals at the call sites for
// the usual reason, sharpened: a typo in "data-nav-criticalpath" is a funnel
// the crawler cannot walk, and nothing local fails — the only signal is a
// price-accuracy complaint from Google weeks later.

/** The stage names we declare. Google treats these as labels, not a state
 *  machine — they exist so a validation failure says WHERE it stopped. */
export type NavStage = "landing" | "room-selection" | "checkout";

/**
 * Attributes for the page's root container.
 *
 * `final` marks the last page a guest can reach before entering payment or
 * personal details, which is where the crawler stops and reads the price.
 * Exactly one page in the funnel may carry it.
 */
export function navStage(stage: NavStage, final = false) {
  return {
    "data-nav-stage": stage,
    ...(final ? { "data-nav-stage-final": "true" } : {}),
  } as const;
}

/**
 * Attributes for the one element the crawler must click to advance.
 *
 * `order` is only needed when a single page requires more than one click; our
 * funnel deliberately avoids that by marking a different element depending on
 * cart state (see results.tsx), so it is normally omitted.
 */
export function navCriticalPath(order?: number) {
  return {
    "data-nav-criticalpath": "true",
    "data-nav-interactiontype": "CLICK",
    ...(order === undefined ? {} : { "data-nav-interactionorder": String(order) }),
  } as const;
}

/** Marks a spinner/mask so the crawler waits for it (up to 15s) instead of
 *  clicking through a page that is still resolving prices. */
export const NAV_LOADING = { "data-nav-loading-indicator": "true" } as const;

/**
 * The co-typed root scope Google requires on the final page: one element that
 * is both the Hotel and the LodgingReservation. React renders `itemScope` as
 * the bare `itemscope` attribute.
 */
export const hotelReservationScope = {
  itemScope: true,
  itemType: "https://schema.org/Hotel https://schema.org/LodgingReservation",
} as const;

/** The Offer inside that scope. One hotel, one offer, one price per page. */
export const offerScope = {
  itemProp: "makesOffer",
  itemScope: true,
  itemType: "https://schema.org/Offer",
} as const;

/** The Offer's price container. */
export const priceSpecScope = {
  itemProp: "priceSpecification",
  itemScope: true,
  itemType: "https://schema.org/CompoundPriceSpecification",
} as const;

/** One line of the price breakdown, inside the CompoundPriceSpecification. */
export const unitPriceScope = {
  itemProp: "priceComponent",
  itemScope: true,
  itemType: "https://schema.org/UnitPriceSpecification",
} as const;
