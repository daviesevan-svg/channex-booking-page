// Error boundary for every guest page, rendered INSIDE the property layout.
//
// A route's ErrorBoundary replaces that route's own component, so on the layout
// it would take the hotel's header, footer and theme down with it — which is
// exactly what happened: every guest 404 fell through to root's bare "404" on
// the default cream, with no way back to booking. This pathless route sits
// between the layout and the pages instead. It renders nothing of its own, and
// when a page below it throws, the boundary lands in the layout's Outlet, so the
// guest keeps the hotel's branding, language and navigation.
//
// The status is untouched: a thrown 404 still answers 404, so crawlers drop the
// URL rather than indexing a friendly page.

import { isRouteErrorResponse, Link, Outlet, useOutletContext, useRouteError } from "react-router";

import { useBase, useHome } from "~/lib/base";
import type { PropertyOutletContext } from "~/lib/booking-context";
import { useProperty } from "~/lib/booking-context";
import { useT } from "~/lib/i18n";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

export default function GuestBoundary() {
  // Pass the layout's context straight through — every page reads its language,
  // currency and hotel name from it (useProperty).
  return <Outlet context={useOutletContext<PropertyOutletContext>()} />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const tr = useT();
  const { hotelName } = useProperty();
  const home = useHome();
  const base = useBase();
  const s = useSlots();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const title = tr.t(notFound ? "notFoundTitle" : "errorTitle");

  return (
    <main className="mx-auto max-w-[640px] px-7 pb-[72px] pt-16">
      <title>{hotelName ? `${title} · ${hotelName}` : title}</title>
      <div className="mb-3 text-label font-semibold uppercase tracking-[0.18em] text-accent">
        {notFound ? "404" : tr.t("errorEyebrow")}
      </div>
      <h1 className="mb-4 font-serif text-display-sm font-semibold tracking-[-0.01em]">{title}</h1>
      <p className="mb-8 text-body-lg text-secondary">{tr.t(notFound ? "notFoundBody" : "errorBody")}</p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link
          to={home}
          className={cx(s.btnPrimary, "inline-block px-7 py-[14px] text-lead font-semibold transition-colors")}
        >
          {tr.t("backToHome")}
        </Link>
        {/* No hotel on the shared domain's own root — nothing to manage there. */}
        {hotelName && (
          <Link to={`${base}/manage`} className="text-body font-semibold text-accent hover:underline">
            {tr.t("manageBooking")}
          </Link>
        )}
      </div>
      {import.meta.env.DEV && !notFound && error instanceof Error && (
        <pre className="mt-8 overflow-x-auto rounded-control bg-surface-alt p-4 text-label text-muted">
          {error.stack ?? error.message}
        </pre>
      )}
    </main>
  );
}
