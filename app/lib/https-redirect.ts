// Transport hardening at the Worker edge.
//
// The wildcard route catches plain-HTTP requests too, and until now answered
// them with the full site — booking page, checkout form, admin login — so a
// guest who typed the bare hostname stayed on http:// for the whole funnel,
// and anyone on the path could read or rewrite it. The zone's "Always Use
// HTTPS" is a dashboard setting nobody re-checks; doing it here means it holds
// for every hostname the Worker serves, custom hotel domains included.
//
// Both helpers are gated on APP_URL being https so `npm run dev` on
// http://localhost keeps working untouched — the same signal the session
// cookies use for their `Secure` flag.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A redirect to the https:// twin of a plain-HTTP request, or null when the
 *  request is already secure (or this deployment isn't). GET/HEAD get a 301;
 *  anything else a 308 so the method and body survive the hop. */
export function httpsRedirect(request: Request, appUrl: string): Response | null {
  if (!appUrl.startsWith("https://")) return null;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || LOCAL_HOSTS.has(url.hostname)) return null;
  url.protocol = "https:";
  const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
  return new Response(null, { status, headers: { Location: url.toString() } });
}

/** One year, this host only. No `includeSubDomains`: a hotel's custom domain
 *  may have other subdomains served elsewhere over plain HTTP, and a policy
 *  set from their booking page must not break those. */
export const HSTS_VALUE = "max-age=31536000";

/** Adds Strict-Transport-Security to a response served over https. Returns the
 *  same response when there's nothing to add. */
export function withHsts(response: Response, request: Request, appUrl: string): Response {
  if (!appUrl.startsWith("https://")) return response;
  let secure: boolean;
  try {
    secure = new URL(request.url).protocol === "https:";
  } catch {
    return response;
  }
  if (!secure || response.headers.has("Strict-Transport-Security")) return response;
  // Redirect() responses carry immutable headers, so clone rather than set.
  const out = new Response(response.body, response);
  out.headers.set("Strict-Transport-Security", HSTS_VALUE);
  return out;
}
