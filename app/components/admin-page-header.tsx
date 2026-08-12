// The admin page's h1 row with its "Saved" confirmation chip — previously an
// 8-line block pasted into ~20 admin pages, with three incompatible success
// guards (one of which showed "Saved" over error responses) and drifting
// margins. `saved` must be the action's SUCCESS, not the mere presence of a
// response.
import type { ReactNode } from "react";

import { useAdminT } from "~/lib/admin-i18n";

/** The green confirmation chip. Children override the label; the default is
 *  the translated "Saved". */
export function SavedPill({ show, children }: { show: boolean; children?: ReactNode }) {
  const t = useAdminT();
  if (!show) return null;
  return (
    <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
      {children ?? t("saved")}
    </span>
  );
}

export function AdminPageHeader({
  title,
  saved = false,
  message,
  className = "mb-5",
  children,
}: {
  title: ReactNode;
  /** Show the Saved chip — pass the action's success, e.g. `Boolean(actionData?.ok)`. */
  saved?: boolean;
  /** Chip text override, rendered as "✓ message". */
  message?: string;
  /** Margin/gap overrides for the row (default `mb-5`). */
  className?: string;
  /** Extra right-side content, rendered between the title and the chip. */
  children?: ReactNode;
}) {
  return (
    <div className={`${className} flex items-center justify-between`}>
      <h1 className="font-serif text-[26px] font-semibold">{title}</h1>
      {children}
      <SavedPill show={saved}>{message != null ? <>✓ {message}</> : undefined}</SavedPill>
    </div>
  );
}
