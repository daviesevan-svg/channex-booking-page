import { useEffect, useState } from "react";
import { Form, Link, NavLink, Outlet, useLocation, useSearchParams } from "react-router";

import type { Route } from "./+types/layout";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getVisibleProperties, isOwnerOrSuper } from "~/lib/properties.server";
import { isSuperadmin } from "~/lib/users.server";
import { DEFAULT_LANG, enabledLanguages, langParam, langLabel } from "~/lib/content";
import { getSettings } from "~/lib/overrides.server";
import { getConfig } from "~/lib/config.server";

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
  // Test mode = live bookings not enabled → checkout simulates and takes no
  // payment. Surfaced as a persistent banner so it's never a surprise. Only
  // meaningful once a property is selected.
  const testMode = Boolean(propertyId) && !(settings.liveBooking ?? getConfig().allowLiveBooking);
  return {
    email,
    propertyId,
    properties,
    isSuperadmin: superadmin,
    canManageCurrent,
    testMode,
    lang: langParam(request),
    languages: enabledLanguages(settings),
  };
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-[10px] px-3.5 py-2.5 text-[14px] font-semibold ${
    isActive ? "bg-surface text-ink" : "text-muted hover:text-ink"
  }`;

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { email, propertyId, properties, isSuperadmin, canManageCurrent, testMode, lang, languages } =
    loaderData;
  const context: AdminContext = { propertyId, lang };
  const [navOpen, setNavOpen] = useState(true);
  const { pathname } = useLocation();

  // Nav is grouped into collapsible sections. Each starts collapsed; the section
  // holding the current page auto-expands so you never lose your place.
  interface NavItem {
    to: string;
    label: string;
    end?: boolean;
  }
  const sections: { title: string; items: NavItem[] }[] = [
    {
      title: "Operations",
      items: [
        { to: "/admin/inventory", label: "Inventory" },
        { to: "/admin/analytics", label: "Analytics" },
        { to: "/admin/ari-log", label: "Change log" },
        { to: "/admin/bookings", label: "Bookings" },
      ],
    },
    {
      title: "Settings",
      items: [
        // Property basics
        { to: "/admin", label: "Property details", end: true },
        { to: "/admin/general", label: "General" },
        { to: "/admin/portal", label: "Customer Portal" },
        // Catalogue & pricing
        { to: "/admin/rooms", label: "Rooms" },
        { to: "/admin/rates", label: "Rates" },
        { to: "/admin/taxes", label: "Taxes & Fees" },
        { to: "/admin/promotions", label: "Promotions" },
        { to: "/admin/extras", label: "Extras" },
        // Integrations
        { to: "/admin/connectivity", label: "Connectivity" },
        { to: "/admin/google-hotels", label: "Google Hotels" },
        { to: "/admin/website-widget", label: "Website widget" },
        { to: "/admin/brand-kit", label: "Brand kit" },
        { to: "/admin/payments", label: "Payments" },
        ...(canManageCurrent ? [{ to: "/admin/api-keys", label: "API keys" }] : []),
        ...(canManageCurrent ? [{ to: "/admin/webhooks", label: "Webhooks" }] : []),
        // Access & management
        ...(canManageCurrent ? [{ to: "/admin/team", label: "Team" }] : []),
        { to: "/admin/properties", label: "Properties" },
        { to: "/admin/collections", label: "Collections" },
        ...(isSuperadmin ? [{ to: "/admin/users", label: "Users" }] : []),
      ],
    },
    {
      title: "Pages",
      items: [
        { to: "/admin/home", label: "Home" },
        { to: "/admin/pages/results", label: "Results" },
        { to: "/admin/pages/detail", label: "Room detail" },
        { to: "/admin/pages/extras", label: "Extras" },
        { to: "/admin/pages/checkout", label: "Checkout" },
        { to: "/admin/pages/confirmation", label: "Confirmation" },
      ],
    },
    {
      title: "Emails",
      items: [
        { to: "/admin/emails", label: "Settings", end: true },
        { to: "/admin/emails/booking_confirmation", label: "Booking confirmation" },
        { to: "/admin/emails/host_notification", label: "New booking (to you)" },
        { to: "/admin/emails/booking_cancellation", label: "Cancellation (guest)" },
        { to: "/admin/emails/cancellation_notification", label: "Cancellation (to you)" },
        { to: "/admin/emails/booking_failed", label: "Couldn't confirm (guest)" },
      ],
    },
  ];
  const itemActive = (it: NavItem) =>
    it.end ? pathname === it.to : pathname === it.to || pathname.startsWith(`${it.to}/`);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sections.map((s) => [s.title, s.items.some(itemActive)])),
  );
  // Keep the section containing the current page open across client-side
  // navigations (without collapsing any the user opened themselves).
  useEffect(() => {
    const active = sections.find((s) => s.items.some(itemActive));
    if (active) setOpenSections((o) => (o[active.title] ? o : { ...o, [active.title]: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  // Wide pages (the inventory grid, the change log table) break out of the
  // centred column to use the full width.
  const wide = pathname.startsWith("/admin/inventory") || pathname.startsWith("/admin/ari-log");
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
              // reloadDocument: switching property does a full-page reload, so the
              // whole admin re-renders from fresh SSR under the new property. A
              // client-side navigation could leave the page showing the old
              // property (stale uncontrolled inputs, or the Set-Cookie racing
              // revalidation); a document reload is deterministic across envs.
              <Form method="post" action="/admin/select-property" reloadDocument className="flex items-center gap-1.5">
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

      {testMode && (
        <div className="border-b border-amber-200 bg-amber-50">
          <div className={`flex ${shell} flex-wrap items-center justify-between gap-3 px-6 py-2.5`}>
            <span className="text-[13px] text-amber-900">
              <strong>Test mode.</strong> Bookings are simulated — nothing is sent to Channex and no
              payment is taken. Guests can’t really book yet.
            </span>
            <Link
              to="/admin/general"
              className="flex-none rounded-[8px] bg-amber-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-amber-700"
            >
              Activate live bookings →
            </Link>
          </div>
        </div>
      )}

      <div className={`flex ${shell} gap-8 px-6 py-8`}>
        <nav className={`${navOpen ? "block" : "hidden"} w-44 flex-none space-y-1`}>
          {sections.map((section) => {
            const isOpen = openSections[section.title] ?? false;
            return (
              <div key={section.title}>
                <button
                  type="button"
                  onClick={() =>
                    setOpenSections((o) => ({ ...o, [section.title]: !(o[section.title] ?? false) }))
                  }
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-2 rounded-[8px] px-3.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-faint hover:text-muted"
                >
                  <span>{section.title}</span>
                  <span
                    aria-hidden="true"
                    className={`text-[9px] transition-transform ${isOpen ? "rotate-90" : ""}`}
                  >
                    ▶
                  </span>
                </button>
                {isOpen && (
                  <div className="space-y-1">
                    {section.items.map((item) => (
                      <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass}>
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <main className="min-w-0 flex-1">
          <Outlet context={context} />
        </main>
      </div>
    </div>
  );
}
