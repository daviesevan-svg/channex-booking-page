import { isRouteErrorResponse, Link, useRevalidator, useRouteError } from "react-router";

import { useAdminT } from "~/lib/admin-i18n";

const primaryBtn = "rounded-[10px] bg-accent px-4 py-2 text-[13px] font-semibold text-white hover:bg-accent-deep";
const secondaryBtn =
  "rounded-[10px] border border-line-alt bg-surface px-4 py-2 text-[13px] font-semibold text-ink hover:border-accent hover:text-accent";

/** Shown when an admin loader or render throws. Rendered from the pathless
 *  boundary under the layout (so the sidebar stays) and from the layout's own
 *  boundary (when the layout loader itself failed and the sidebar is gone). */
export function AdminRouteError() {
  const error = useRouteError();
  const t = useAdminT();
  const revalidator = useRevalidator();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const retrying = revalidator.state !== "idle";

  return (
    <div className="mx-auto max-w-[640px] px-6 py-16">
      <h1 className="mb-3 font-serif text-[28px] font-semibold">
        {t(notFound ? "adminNotFoundTitle" : "adminErrorTitle")}
      </h1>
      <p className="mb-6 text-[15px] text-secondary">
        {t(notFound ? "adminNotFoundBody" : "adminErrorBody")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => revalidator.revalidate()} disabled={retrying} className={primaryBtn}>
          {t("adminErrorRetry")}
        </button>
        <Link to="/admin" className={secondaryBtn}>
          {t("adminErrorHome")}
        </Link>
      </div>
      {import.meta.env.DEV && !notFound && error instanceof Error && (
        <pre className="mt-8 overflow-x-auto rounded-[10px] bg-surface-alt p-4 text-[12px] text-muted">
          {error.stack ?? error.message}
        </pre>
      )}
    </div>
  );
}
