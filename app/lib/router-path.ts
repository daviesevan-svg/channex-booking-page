// The path the ROUTER matches, for code that guards by path.
//
// React Router matches case-insensitively and percent-decodes each segment
// before matching, so "/admin/Payments" and "/admin/%70ayments" both load the
// /admin/payments route. A guard that compares the raw `url.pathname` against
// a lower-case literal reads a different path from the one that gets served —
// and the difference is a way round the guard. Compare this instead.
//
// Client-safe and pure. Mirrors react-router's decodePath (per segment, a
// decoded "/" stays "%2F", a malformed escape leaves the path as it was) and
// its case-insensitive route regexes.
export function routerPath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\//g, "%2F"))
      .join("/");
  } catch {
    /* malformed escape — the router matches the raw path too */
  }
  return decoded.toLowerCase();
}
