// Security headers for HTML documents.
//
// Applied only from entry.server.tsx — React Router's document renderer — so
// JSON/API routes, /embed.js, PDFs, feeds, and /images/* never receive an HTML
// Content-Security-Policy they do not need. Images already set their own
// `CSP: sandbox` + nosniff in routes/image.tsx; this is the matching care for
// documents that was missing.
//
// Framing is path-scoped, not one blanket DENY:
//
//  * /admin*  — `frame-ancestors 'none'` (+ X-Frame-Options: DENY). Stops a
//    third-party page from clickjacking Connect, team invite, or any other
//    admin action on book.roompanda.com.
//  * /embed/* — `frame-ancestors *` and no X-Frame-Options. Hotels drop
//    embed.js on their own site, which iframes /embed/:id; the ancestor origin
//    is unknown. The admin widget preview can also be cross-origin (partner
//    guest host ≠ admin host).
//  * everything else (guest funnel, collections, Viva return) — `'self'`
//    (+ X-Frame-Options: SAMEORIGIN). The design-preview iframe on the admin
//    website screen loads `/{slug}?style=…` same-origin. Third parties cannot
//    frame checkout. Payments themselves are not framed: Stripe Checkout and
//    Viva Smart Checkout are top-level 302s after a same-origin form POST.
//
// CSP exceptions that would break the existing app if omitted:
//
//  * script-src/style-src `'unsafe-inline'` — React Router hydration, the
//    FontStylesheet loader, JSON-adjacent inline tags, and React `style={{}}`.
//    A nonce would be tighter but would have to thread through every inline
//    emission; that is a follow-up, not this change.
//  * maps.googleapis.com / maps.gstatic.com / *.googleapis.com — click-to-load
//    Maps JS (guest location section, collection map, admin geocode).
//  * fonts.googleapis.com / fonts.gstatic.com — the FONT_PAIRS stylesheets.
//  * img-src https: — hotel-supplied photos, partner favicons, booking.com
//    import URLs, and Maps tiles (khms*, streetview, gstatic).
//  * form-action Stripe + Viva hosts — Chrome applies form-action to the
//    *redirect* after a form POST. Checkout and Connect OAuth POST to us,
//    then 302 to checkout.stripe.com / connect.stripe.com /
//    (demo.)vivapayments.com. Restricting form-action to 'self' alone would
//    abort those payments in Chrome. No frame-src exception: we do not embed
//    Stripe.js / hosted fields / Viva widgets.

export type FrameAncestors = "none" | "self" | "*";

/** True when `pathname` is `/segment` or `/segment/…` (not `/segment-other`). */
function atSegment(pathname: string, segment: string): boolean {
  const path = pathname.toLowerCase();
  return path === `/${segment}` || path.startsWith(`/${segment}/`);
}

export function frameAncestorsForPath(pathname: string): FrameAncestors {
  if (atSegment(pathname, "embed")) return "*";
  if (atSegment(pathname, "admin")) return "none";
  return "self";
}

export function documentContentSecurityPolicy(pathname: string): string {
  const ancestors = frameAncestorsForPath(pathname);
  const frameAncestors = ancestors === "*" ? "*" : `'${ancestors}'`;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // Hydration + FontStylesheet + Maps bootstrap (maps.google* only; no Stripe.js).
    "script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://maps.googleapis.com https://maps.gstatic.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com",
    "worker-src 'self' blob:",
    // Same-origin design/widget preview iframes. Email preview uses srcdoc.
    "frame-src 'self'",
    // See file comment: Chrome walks the POST→302 chain against form-action.
    "form-action 'self' https://*.stripe.com https://*.vivapayments.com",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

export function htmlSecurityHeaders(pathname: string): Record<string, string> {
  const ancestors = frameAncestorsForPath(pathname);
  const headers: Record<string, string> = {
    "Content-Security-Policy": documentContentSecurityPolicy(pathname),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
  // X-Frame-Options has no "allow all" value — omit it on /embed/* so hotel
  // sites can frame the widget. CSP frame-ancestors is the real control.
  if (ancestors === "none") headers["X-Frame-Options"] = "DENY";
  if (ancestors === "self") headers["X-Frame-Options"] = "SAMEORIGIN";
  return headers;
}

export function applyHtmlSecurityHeaders(headers: Headers, request: Request): void {
  const { pathname } = new URL(request.url);
  for (const [name, value] of Object.entries(htmlSecurityHeaders(pathname))) {
    headers.set(name, value);
  }
}
