import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),

  // Public image server (R2-backed)
  route("images/*", "routes/image.tsx"),

  // Open Channel API (Channex → us): ARI push + handshake endpoints.
  route("api/test_connection", "routes/api.test_connection.tsx"),
  route("api/mapping_details", "routes/api.mapping_details.tsx"),
  route("api/changes", "routes/api.changes.tsx"),

  // Admin (magic-link protected)
  route("admin/login", "routes/admin/login.tsx"),
  route("admin/verify", "routes/admin/verify.tsx"),
  route("admin/logout", "routes/admin/logout.tsx"),
  route("admin", "routes/admin/layout.tsx", [
    index("routes/admin/property.tsx"),
    route("properties", "routes/admin/properties.tsx"),
    route("users", "routes/admin/users.tsx"),
    route("team", "routes/admin/team.tsx"),
    route("select-property", "routes/admin/select-property.tsx"),
    route("general", "routes/admin/general.tsx"),
    route("connectivity", "routes/admin/connectivity.tsx"),
    route("payments", "routes/admin/payments.tsx"),
    route("payments/callback", "routes/admin/payments.callback.tsx"),
    route("portal", "routes/admin/portal.tsx"),
    route("home", "routes/admin/home.tsx"),
    route("pages/:page", "routes/admin/page.tsx"),
    route("rooms", "routes/admin/rooms.tsx"),
    route("rooms/:roomId", "routes/admin/room.tsx"),
    route("rates", "routes/admin/rates.tsx"),
    route("rates/:rateId", "routes/admin/rate.tsx"),
    route("inventory", "routes/admin/inventory.tsx"),
    route("taxes", "routes/admin/taxes.tsx"),
    route("promotions", "routes/admin/promotions.tsx"),
    route("extras", "routes/admin/extras.tsx"),
    route("emails", "routes/admin/emails.tsx"),
    route("emails/:template", "routes/admin/email.tsx"),
    route("bookings", "routes/admin/bookings.tsx"),
    route("bookings/:id", "routes/admin/booking.tsx"),
  ]),

  // Guest booking flow
  route(":channelId", "routes/property/layout.tsx", [
    index("routes/property/search.tsx"),
    route("rooms", "routes/property/results.tsx"),
    route("rooms/:roomId", "routes/property/detail.tsx"),
    route("extras", "routes/property/extras.tsx"),
    route("checkout", "routes/property/checkout.tsx"),
    route("confirmation/:ref", "routes/property/confirmation.tsx"),
    route("manage", "routes/property/manage.tsx"),
    route("manage/:id", "routes/property/manage-booking.tsx"),
  ]),
] satisfies RouteConfig;
