// Admin tab titles, in the admin's own language.
//
// Deliberately NOT in page-meta.ts beside the guest-facing `pageMeta`. That
// module is imported by every guest route, and a static import of the admin
// dictionary from it put 82 kB gzipped of admin translations into the bundle of
// every hotel's public landing page. Splitting the two is the whole point of
// this file, so keep it free of runtime imports from page-meta — including the
// reverse mistake, which would pull all eight GUEST locales into admin pages.
//
// A Portuguese admin staring at an English browser tab is the same bug the guest
// titles had, wearing a different hat.

import { adminT, isAdminLang } from "./admin-i18n";

/** Structural subset of what React Router hands `meta()` — every route's
 *  generated `matches` tuple is assignable to this. Declared here rather than
 *  imported so this module keeps no edge back to the guest side. */
type MetaMatch = { id: string; loaderData?: unknown } | undefined;

const ADMIN_LAYOUT_ID = "routes/admin/layout";

/**
 * `text` wins over `key`, for pages titled after a record (a voucher code, an
 * email template) rather than after a fixed label.
 */
export function adminMeta(
  matches: readonly MetaMatch[],
  { key, text, vars }: { key?: string; text?: string; vars?: Record<string, string | number> },
): Array<Record<string, string>> {
  const data = matches.find((m) => m?.id === ADMIN_LAYOUT_ID)?.loaderData as
    | { adminLang?: string }
    | undefined;
  const raw = data?.adminLang ?? "";
  const t = adminT(isAdminLang(raw) ? raw : "en");
  const label = text?.trim() || (key ? t(key, vars) : "");
  return [{ title: label ? `${t("mtAdmin")} · ${label}` : t("mtAdmin") }];
}
