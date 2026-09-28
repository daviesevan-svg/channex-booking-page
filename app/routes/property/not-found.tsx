// Catch-all for guest URLs no page matches, so they 404 inside the hotel's own
// layout (guest-boundary.tsx) instead of falling out to root's unbranded page.
//
// Registered last on each mount; React Router ranks a splat below every static
// and dynamic route, so it only ever sees paths nothing else claimed.

export function loader(): never {
  throw new Response("Not found", { status: 404 });
}

// A component makes this a UI route. Without one it would be a resource route,
// and a resource route's thrown Response goes back raw — plain-text "Not found"
// — instead of reaching the boundary. Never rendered: the loader always throws.
export default function NotFound() {
  return null;
}
