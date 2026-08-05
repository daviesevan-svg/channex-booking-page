import {
  type RouteConfig,
  type RouteConfigEntry,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

/**
 * The guest tree's children, shared by both mounts.
 *
 * A property is reachable two ways — `/spilmanhotel/rooms` on the shared domain
 * and `/rooms` on the hotel's own — and both must serve the SAME modules. Listing
 * them once is the point: a route added to one mount and forgotten on the other
 * is a page that silently exists at only one address.
 *
 * `prefix` set = the root mount, which needs explicit route ids because these
 * modules are already used by the mount that has a path. Unprefixed keeps the
 * file-derived ids, so nothing referring to them by name changes.
 *
 * The index is NOT here: the two mounts want different things at their root
 * (`/spilmanhotel` is the property home; `/` is either the picker or a hotel's
 * own home page), so each declares its own.
 */
function guestRoutes(prefix?: string): RouteConfigEntry[] {
  const r = (path: string, file: string, name: string) =>
    prefix ? route(path, file, { id: `${prefix}-${name}` }) : route(path, file);
  return [
    r("rooms", "routes/property/results.tsx", "rooms"),
    r("rooms/:roomId", "routes/property/detail.tsx", "detail"),
    // Website room page (no dates needed) — distinct from the dated funnel step.
    r("room/:roomId", "routes/property/room.tsx", "room"),
    // Website offers pages: the list, and one offer with its own availability
    // calendar (the room/rooms pair again — static before dynamic, so the list
    // keeps the bare /offers URL).
    r("offers", "routes/property/offers.tsx", "offers"),
    r("offers/:offerId", "routes/property/offer.tsx", "offer"),
    // Contact-form submission (POST only; GET redirects home).
    r("contact", "routes/property/contact.tsx", "contact"),
    r("extras", "routes/property/extras.tsx", "extras"),
    r("vouchers", "routes/property/vouchers.tsx", "vouchers"),
    r("vouchers/complete", "routes/property/vouchers-complete.tsx", "vouchers-complete"),
    r("vouchers/:productId", "routes/property/voucher-buy.tsx", "voucher-buy"),
    r("voucher/:code", "routes/property/voucher.tsx", "voucher"),
    r("voucher/:code/pdf", "routes/property/voucher-pdf.tsx", "voucher-pdf"),
    r("voucher/:code/book", "routes/property/voucher-book.tsx", "voucher-book"),
    r("checkout", "routes/property/checkout.tsx", "checkout"),
    r("checkout/complete", "routes/property/checkout.complete.tsx", "checkout-complete"),
    r("confirmation/:ref", "routes/property/confirmation.tsx", "confirmation"),
    r("manage", "routes/property/manage.tsx", "manage"),
    r("manage/voucher/:code", "routes/property/manage-voucher.tsx", "manage-voucher"),
    r("manage/:id", "routes/property/manage-booking.tsx", "manage-booking"),
    r("review/:bookingId", "routes/property/review.tsx", "review"),
    // Extra website pages ("about", "dining"). Under /p/ because a single segment
    // at the ROOT of a custom domain is ambiguous — /parking is a page there,
    // while /spilmanhotel on the shared domain is a property, and route matching
    // cannot see the hostname. Static prefix = no ambiguity on either mount.
    // See RESERVED_PAGE_SLUGS in app/lib/pages.ts.
    r("p/:pageSlug", "routes/property/page.tsx", "page"),
  ];
}

export default [

  // Public image server (R2-backed)
  route("images/*", "routes/image.tsx"),

  // Google Hotel List Feed (XML, Google pulls on a schedule).
  route("feeds/google-hotels.xml", "routes/feeds.hotel-list.tsx"),
  // Merged feed: Channex's partner feed passed through + our properties added.
  route("feeds/google-hotels-all.xml", "routes/feeds.google-merged.tsx"),
  // Google Vacation Rentals list feed (XML, Google pulls on a schedule).
  route("feeds/google-vacation-rentals.xml", "routes/feeds.google-vr.tsx"),
  // Merged VR feed: Channex's VR partner feed passed through + our properties added.
  route("feeds/google-vacation-rentals-all.xml", "routes/feeds.google-merged-vr.tsx"),
  // Same feed zipped — Google requires the pulled VR list-feed URL to be a .zip.
  route("feeds/google-vacation-rentals-all.zip", "routes/feeds.google-vr-zip.tsx"),
  // Google Hotels landing target: routes our hotels to our flow, forwards the
  // rest to Channex's booking_link. (Google POS <URL> points here.)
  route("go/booking", "routes/go.booking.tsx"),

  // Open Channel API (Channex → us): ARI push + handshake endpoints.
  route("api/test_connection", "routes/api.test_connection.tsx"),
  route("api/mapping_details", "routes/api.mapping_details.tsx"),
  route("api/changes", "routes/api.changes.tsx"),
  route("api/stripe-webhook", "routes/api.stripe-webhook.tsx"),

  // Model Context Protocol endpoint — same per-property API key as /v1, so an AI
  // agent can search availability and book without driving a browser.
  route("mcp", "routes/mcp.tsx"),

  // Public REST API (v1), authenticated by per-property API keys.
  route("v1/openapi.json", "routes/api.v1.openapi.tsx"),
  route("v1/properties", "routes/api.v1.properties.tsx"),
  route("v1/properties/:id", "routes/api.v1.properties.$id.tsx"),
  route("v1/calendar", "routes/api.v1.calendar.tsx"),
  route("v1/rooms", "routes/api.v1.rooms.tsx"),
  route("v1/availability", "routes/api.v1.availability.tsx"),
  route("v1/rates", "routes/api.v1.rates.tsx"),
  route("v1/extras", "routes/api.v1.extras.tsx"),
  route("v1/bookings", "routes/api.v1.bookings.tsx"),
  route("v1/bookings/:id", "routes/api.v1.bookings.$id.tsx"),

  // Admin (magic-link protected)
  route("admin/login", "routes/admin/login.tsx"),
  route("admin/verify", "routes/admin/verify.tsx"),
  route("admin/logout", "routes/admin/logout.tsx"),
  route("admin/lang", "routes/admin/lang.tsx"),
  route("admin", "routes/admin/layout.tsx", [
    index("routes/admin/property.tsx"),
    route("properties", "routes/admin/properties.tsx"),
    route("properties/onboard", "routes/admin/onboard-channex.tsx"),
    route("collections", "routes/admin/collections.tsx"),
    route("collections/:slug", "routes/admin/collection.tsx"),
    route("collections/:slug/analytics", "routes/admin/collection-analytics.tsx"),
    route("users", "routes/admin/users.tsx"),
    route("team", "routes/admin/team.tsx"),
    route("select-property", "routes/admin/select-property.tsx"),
    route("general", "routes/admin/general.tsx"),
    route("connectivity", "routes/admin/connectivity.tsx"),
    route("google-hotels", "routes/admin/google-hotels.tsx"),
    route("website-widget", "routes/admin/website-widget.tsx"),
    route("brand-kit", "routes/admin/brand-kit.tsx"),
    route("payments", "routes/admin/payments.tsx"),
    route("payments/callback", "routes/admin/payments.callback.tsx"),
    route("api-keys", "routes/admin/api-keys.tsx"),
    route("webhooks", "routes/admin/webhooks.tsx"),
    route("portal", "routes/admin/portal.tsx"),
    route("home", "routes/admin/home.tsx"),
    route("website", "routes/admin/website.tsx"),
    route("website/sections", "routes/admin/website-sections.tsx"),
    route("website/pages", "routes/admin/website-pages.tsx"),
    route("website/footer", "routes/admin/website-footer.tsx"),
    route("gallery", "routes/admin/gallery.tsx"),
    route("facilities", "routes/admin/facilities.tsx"),
    route("pages/:page", "routes/admin/page.tsx"),
    route("rooms", "routes/admin/rooms.tsx"),
    route("rooms/:roomId", "routes/admin/room.tsx"),
    route("rates", "routes/admin/rates.tsx"),
    route("rates/:rateId", "routes/admin/rate.tsx"),
    route("inventory", "routes/admin/inventory.tsx"),
    route("reviews", "routes/admin/reviews.tsx"),
    route("analytics", "routes/admin/analytics.tsx"),
    route("ari-log", "routes/admin/ari-log.tsx"),
    route("taxes", "routes/admin/taxes.tsx"),
    route("promotions", "routes/admin/promotions.tsx"),
    route("extras", "routes/admin/extras.tsx"),
    route("vouchers", "routes/admin/vouchers.tsx"),
    route("vouchers/:code", "routes/admin/voucher.tsx"),
    route("emails", "routes/admin/emails.tsx"),
    route("emails/:template", "routes/admin/email.tsx"),
    route("bookings", "routes/admin/bookings.tsx"),
    route("bookings/:id", "routes/admin/booking.tsx"),
    route("bookings/:id/pdf", "routes/admin/booking-pdf.tsx"),
  ]),

  // Embeddable booking widget for hotels' own sites: a public loader script +
  // a bare, theme-only date-picker page (no ARI — deep-links into the flow).
  route("embed.js", "routes/embed.script.tsx"),
  route("embed/:channelId", "routes/embed.$channelId.tsx", [
    index("routes/embed.$channelId._index.tsx"),
  ]),

  // Collection landing (multi-property "choose where to stay"). Must precede the
  // :channelId catch-all; the "c" segment is reserved from property slugs.
  route("c/:collectionSlug", "routes/collection.$collectionSlug.tsx"),

  // Guest booking flow, mounted TWICE — see guestRoutes() above.
  //
  //   /:channelId/rooms   shared domain, property in the path
  //   /rooms              custom domain, property from the hostname
  //
  // The shared-domain mount keeps file-derived route ids, so nothing that
  // referenced them by name changes.
  route(":channelId", "routes/property/layout.tsx", [
    index("routes/property/search.tsx"),
    ...guestRoutes(),
    // Website pages at their OLD address. MUST stay last: it matches any single
    // segment, and only React Router's static-beats-dynamic ranking keeps the
    // funnel routes above from being read as page slugs. Redirects real pages,
    // 404s anything else. Only on this mount — a custom domain never had the old
    // shape, so there is nothing to redirect there.
    route(":pageSlug", "routes/property/page-legacy.tsx"),
  ]),

  // The same tree at the root, for a hotel's own domain. Pathless: it contributes
  // no path segment, so its children sit directly under "/". Every child needs an
  // explicit id because the modules are already used by the mount above.
  //
  layout("routes/property/layout.tsx", { id: "host" }, [
    // "/" — a hotel's home page on their own domain, the property picker on ours.
    // One route, because one URL: search.tsx branches on whether the hostname
    // resolved to a property. There is no way to express that in the route table,
    // since matching happens before anything can look at the host.
    index("routes/property/search.tsx", { id: "host-index" }),
    ...guestRoutes("host"),
  ]),
] satisfies RouteConfig;
