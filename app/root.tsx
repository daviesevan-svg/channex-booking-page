import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import type { Route } from "./+types/root";
import { langFromRequest } from "./lib/content";
import { DefaultFontFaces } from "./components/font-faces";
import { adminLangFromRequest, registerAdminDict } from "./lib/admin-i18n";
import { adminDictFor } from "./lib/admin-i18n-locales.server";
import { isOwnHost } from "./lib/domains.server";
import { getPartner, partnerIdForAdminHost, partnerIdForGuestHost } from "./lib/partners.server";
import { registerDict } from "./lib/i18n";
import { guestDictFor } from "./lib/i18n-locales.server";
import "./app.css";

/**
 * The guest language, plus its labels when they aren't already in the bundle.
 *
 * This is how the seven non-English dictionaries reach the browser: as data for
 * the language actually being served, instead of as JS for all of them. English
 * pages send nothing extra at all.
 */
/** Root data is a function of the host (favicon), the /admin boundary, and the
 *  language — not of the funnel's ever-changing search params. Left to the
 *  default, every cart edit re-ran this loader and re-shipped the entire guest
 *  dictionary in the .data payload. Language switches are either a `?lang=`
 *  navigation (compared here) or a cookie set by a mutation (formMethod). */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentUrl.pathname.startsWith("/admin") !== nextUrl.pathname.startsWith("/admin")) return true;
  return currentUrl.searchParams.get("lang") !== nextUrl.searchParams.get("lang");
}

export async function loader({ request }: Route.LoaderArgs) {
  // A white-label partner's hosts (admin door and guest booking domain) carry
  // the partner's favicon on every page. Only looked up off our own hosts, so
  // the shared domain pays nothing; a hotel's custom domain pays two KV reads
  // that miss — the same order of cost as its own host lookup.
  const url = new URL(request.url);
  let favicon: string | null = null;
  if (!isOwnHost(url.hostname)) {
    const partnerId =
      (await partnerIdForAdminHost(url.hostname)) ?? (await partnerIdForGuestHost(url.hostname));
    if (partnerId) favicon = (await getPartner(partnerId))?.faviconImage || null;
  }
  // The admin is its own language, chosen by the signed-in user rather than by
  // the guest cookie, so `lang` on an admin page has to come from there — and
  // it is not cosmetic. `text-transform: uppercase` is language-aware: a Turkish
  // admin labelled lang="en" gets "BILGI" where Turkish wants "BİLGİ", because
  // only tr maps i → İ. The admin needs no guest dictionary; it has its own.
  if (url.pathname.startsWith("/admin")) {
    // The admin's own dictionary rides the same channel as the guest one:
    // data for the one language being served, not JS for all six.
    const adminLang = adminLangFromRequest(request);
    return { lang: adminLang, dict: null, adminDict: adminDictFor(adminLang), favicon };
  }
  const lang = langFromRequest(request);
  return { lang, dict: guestDictFor(lang), adminDict: null, favicon };
}

// No `links()`: the two preconnects that used to live here warmed a connection
// to fonts.googleapis.com / fonts.gstatic.com, and nothing on the page talks to
// either any more — the faces are inlined by <DefaultFontFaces> in the Layout
// below and served from our own origin. A preconnect to a host we never call is
// a DNS + TLS handshake spent on nothing.

export function Layout({ children }: { children: React.ReactNode }) {
  // Registered during THIS render, so it is in place before any descendant
  // calls useT() — on the server, during hydration, and again after a
  // client-side language switch revalidates this loader. `undefined` on an
  // error render, where there is no loader data.
  const data = useRouteLoaderData<typeof loader>("root");
  registerDict(data?.lang ?? "", data?.dict);
  // On admin pages `lang` IS the admin language (see the loader) and this must
  // run before <Meta /> renders — adminMeta() translates the tab title.
  registerAdminDict(data?.lang ?? "", data?.adminDict);

  return (
    // Was hardcoded "en", which told screen readers and search engines that a
    // French page was English.
    <html lang={data?.lang || "en"}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        {data?.favicon && <link rel="icon" href={data.favicon} />}
        <DefaultFontFaces />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
