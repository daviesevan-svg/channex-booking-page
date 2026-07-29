import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { DEFAULT_FONTS_HREF, langFromRequest } from "./lib/content";
import { FontStylesheet } from "./components/font-stylesheet";
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
export function loader({ request }: Route.LoaderArgs) {
  const lang = langFromRequest(request);
  return { lang, dict: guestDictFor(lang) };
}

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
];
// The default pair is loaded by <FontStylesheet> in the Layout below rather than
// declared here: as a `links()` entry it was a render-blocking stylesheet, and
// PageSpeed costed that third-party round trip at 750 ms.

export function Layout({ children }: { children: React.ReactNode }) {
  // Registered during THIS render, so it is in place before any descendant
  // calls useT() — on the server, during hydration, and again after a
  // client-side language switch revalidates this loader. `undefined` on an
  // error render, where there is no loader data.
  const data = useRouteLoaderData<typeof loader>("root");
  registerDict(data?.lang ?? "", data?.dict);

  return (
    // Was hardcoded "en", which told screen readers and search engines that a
    // French page was English.
    <html lang={data?.lang || "en"}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <FontStylesheet href={DEFAULT_FONTS_HREF} />
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
