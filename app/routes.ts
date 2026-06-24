import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),

  // Public image server (R2-backed)
  route("images/*", "routes/image.tsx"),

  // Admin (magic-link protected)
  route("admin/login", "routes/admin/login.tsx"),
  route("admin/verify", "routes/admin/verify.tsx"),
  route("admin/logout", "routes/admin/logout.tsx"),
  route("admin", "routes/admin/layout.tsx", [
    index("routes/admin/property.tsx"),
    route("general", "routes/admin/general.tsx"),
    route("home", "routes/admin/home.tsx"),
    route("pages/:page", "routes/admin/page.tsx"),
    route("rooms", "routes/admin/rooms.tsx"),
    route("rooms/:roomId", "routes/admin/room.tsx"),
    route("rates", "routes/admin/rates.tsx"),
    route("rates/:rateId", "routes/admin/rate.tsx"),
    route("bookings", "routes/admin/bookings.tsx"),
    route("bookings/:id", "routes/admin/booking.tsx"),
  ]),

  // Guest booking flow
  route(":channelId", "routes/property/layout.tsx", [
    index("routes/property/search.tsx"),
    route("rooms", "routes/property/results.tsx"),
    route("rooms/:roomId", "routes/property/detail.tsx"),
    route("checkout", "routes/property/checkout.tsx"),
    route("confirmation/:ref", "routes/property/confirmation.tsx"),
  ]),
] satisfies RouteConfig;
