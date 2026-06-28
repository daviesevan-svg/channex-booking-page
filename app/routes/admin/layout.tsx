import { useState } from "react";
import { Form, Link, NavLink, Outlet, useLocation, useSearchParams } from "react-router";

import type { Route } from "./+types/layout";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getVisibleProperties, isOwnerOrSuper } from "~/lib/properties.server";
import { isSuperadmin } from "~/lib/users.server";
import { DEFAULT_LANG, enabledLanguages, langParam, langLabel } from "~/lib/content";
import { getSettings } from "~/lib/overrides.server";

export interface AdminContext {
  propertyId?: string;
  lang: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const email = await requireAdmin(request);
  const [propertyId, properties, superadmin] = await Promise.all([
    currentPropertyId(request),
    getVisibleProperties(request),
    isSuperadmin(email),
  ]);
  const settings = propertyId ? await getSettings(propertyId) : {};
  const canManageCurrent = propertyId ? await isOwnerOrSuper(request, propertyId) : false;
  return {
    email,
    propertyId,
    properties,
    isSuperadmin: superadmin,
    canManageCurrent,
    lang: langParam(request),
    languages: enabledLanguages(settings),
  };
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-[10px] px-3.5 py-2.5 text-[14px] font-semibold ${
    isActive ? "bg-surface text-ink" : "text-muted hover:text-ink"
  }`;

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { email, propertyId, properties, isSuperadmin, canManageCurrent, lang, languages } =
    loaderData;
  const context: AdminContext = { propertyId, lang };
  const [navOpen, setNavOpen] = useState(true);
  const { pathname } = useLocation();
  // Wide pages (the inventory grid) break out of the centred column.
  const wide = pathname.startsWith("/admin/inventory");
  const shell = wide ? "max-w-none" : "max-w-[960px]";
  const [, setSearchParams] = useSearchParams();
  const changeLang = (code: string) =>
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (code === DEFAULT_LANG) p.delete("lang");
      else p.set("lang", code);
      return p;
    });

  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="border-b border-nav-border bg-surface-alt">
        <div className={`flex ${shell} items-center justify-between gap-4 px-6 py-4`}>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setNavOpen((v) => !v)}
              aria-label={navOpen ? "Hide menu" : "Show menu"}
              className="rounded-[8px] border border-line-alt px-2.5 py-1.5 text-[15px] leading-none text-muted hover:border-accent hover:text-accent"
            >
              ☰
            </button>
            <Link to="/admin" className="flex items-center gap-3">
              <span
                className="inline-block h-3 w-3 rounded-[2px] bg-accent"
                style={{ transform: "rotate(45deg)" }}
              />
              <span className="font-serif text-[19px] font-semibold">Booking Admin</span>
            </Link>
          </div>
          <div className="flex items-center gap-5 text-[13px] text-muted">
            {properties.length > 0 && (
              <Form method="post" action="/admin/select-property" className="flex items-center gap-1.5">
                <input type="hidden" name="redirectTo" value={pathname} />
                <select
                  name="propertyId"
                  defaultValue={propertyId ?? ""}
                  onChange={(e) => e.currentTarget.form?.requestSubmit()}
                  aria-label="Current property"
                  className="cursor-pointer rounded-[8px] border border-line-alt bg-surface px-2 py-1 text-[13px] font-semibold text-ink outline-none focus:border-accent"
                >
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Form>
            )}
            {languages.length > 1 && (
              <label className="flex items-center gap-1.5">
                <span className="text-faint">Editing</span>
                <select
                  value={lang}
                  onChange={(e) => changeLang(e.target.value)}
                  className="cursor-pointer rounded-[8px] border border-line-alt bg-surface px-2 py-1 text-[13px] font-semibold text-ink outline-none focus:border-accent"
                >
                  {languages.map((code) => (
                    <option key={code} value={code}>
                      {langLabel(code)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {propertyId && (
              <Link to={`/${propertyId}`} className="hover:text-accent" target="_blank">
                View site ↗
              </Link>
            )}
            <span>{email}</span>
            <Form method="post" action="/admin/logout">
              <button type="submit" className="font-semibold hover:text-accent">
                Sign out
              </button>
            </Form>
          </div>
        </div>
      </header>

      <div className={`flex ${shell} gap-8 px-6 py-8`}>
        <nav className={`${navOpen ? "block" : "hidden"} w-44 flex-none space-y-1`}>
          {[
            { to: "/admin/properties", label: "Properties", end: false },
            ...(isSuperadmin ? [{ to: "/admin/users", label: "Users", end: false }] : []),
            { to: "/admin", label: "Property details", end: true },
            ...(canManageCurrent ? [{ to: "/admin/team", label: "Team", end: false }] : []),
            { to: "/admin/general", label: "General", end: false },
            { to: "/admin/connectivity", label: "Connectivity", end: false },
            { to: "/admin/portal", label: "Customer Portal", end: false },
            { to: "/admin/rooms", label: "Rooms", end: false },
            { to: "/admin/rates", label: "Rates", end: false },
            { to: "/admin/inventory", label: "Inventory", end: false },
            { to: "/admin/taxes", label: "Taxes & Fees", end: false },
            { to: "/admin/promotions", label: "Promotions", end: false },
            { to: "/admin/extras", label: "Extras", end: false },
            { to: "/admin/bookings", label: "Bookings", end: false },
          ].map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass}>
              {item.label}
            </NavLink>
          ))}
          <div className="px-3.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-faint">
            Pages
          </div>
          {[
            { to: "/admin/home", label: "Home" },
            { to: "/admin/pages/results", label: "Results" },
            { to: "/admin/pages/detail", label: "Room detail" },
            { to: "/admin/pages/extras", label: "Extras" },
            { to: "/admin/pages/checkout", label: "Checkout" },
            { to: "/admin/pages/confirmation", label: "Confirmation" },
          ].map((item) => (
            <NavLink key={item.to} to={item.to} className={navLinkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="min-w-0 flex-1">
          <Outlet context={context} />
        </main>
      </div>
    </div>
  );
}
