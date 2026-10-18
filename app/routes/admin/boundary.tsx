// Error boundary for every admin page, rendered INSIDE the admin layout.
//
// A route ErrorBoundary replaces that route's own component. Putting it on the
// layout would take the sidebar with it, which is what root's "Oops" already
// does — and then there is no admin link left to click. This pathless route
// sits between the layout and the pages. It renders nothing of its own; when a
// page below it throws, the boundary lands in the layout's Outlet and the
// sidebar stays put.

import { Outlet, useOutletContext } from "react-router";

import { AdminRouteError } from "~/components/admin-route-error";

export default function AdminBoundary() {
  return <Outlet context={useOutletContext()} />;
}

export function ErrorBoundary() {
  return <AdminRouteError />;
}
