// React Router's internal search params, and how to get them out of a URL we
// are about to hand back to the browser.
//
// `_routes` belongs to single-fetch `.data` requests only: it names the subset
// of matched loaders the server should run. It is added by the client to the
// `.data` URL, which means a loader's `request.url` carries it during every
// client-side navigation — and any redirect built by copying that query string
// wholesale bakes the param into the guest's address bar, where it does not
// belong.
//
// From there it is a live bug rather than a cosmetic one: the address bar is
// what forms and client navigations post to, so a later `.data` request goes
// out filtered to a route that isn't even matched on the current page. The
// server answers with a payload missing that page's loader data and the client
// falls into the root error boundary ("An unexpected error occurred") — which
// is exactly how applying a promo code at checkout died, three steps after the
// extras redirect that poisoned the URL.
//
// `index` is NOT here: it is a real, guest-visible param for index-route
// submissions.
const INTERNAL_PARAMS = ["_routes"] as const;

/** Whether a URL carries any param that should never reach the address bar. */
export function hasInternalParams(sp: URLSearchParams): boolean {
  return INTERNAL_PARAMS.some((p) => sp.has(p));
}

/** Drop React Router's internal params, in place. Returns the same object so
 *  it can be used inline. */
export function stripInternalParams(sp: URLSearchParams): URLSearchParams {
  for (const p of INTERNAL_PARAMS) sp.delete(p);
  return sp;
}
