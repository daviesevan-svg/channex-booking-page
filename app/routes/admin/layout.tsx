import { useEffect, useRef, useState } from "react";
import { Form, Link, NavLink, Outlet, useLocation, useSearchParams } from "react-router";

import type { Route } from "./+types/layout";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getVisibleProperties, isOwnerOrSuper } from "~/lib/properties.server";
import { isSuperadmin } from "~/lib/users.server";
import { DEFAULT_LANG, enabledLanguages, langParam, langLabel } from "~/lib/content";
import { getSettings } from "~/lib/overrides.server";
import { getConfig } from "~/lib/config.server";
import { ADMIN_LANGS, adminLangFromRequest, adminT, type AdminT } from "~/lib/admin-i18n";

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
    adminLang: adminLangFromRequest(request),
  };
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-[10px] px-3.5 py-2.5 text-[14px] font-semibold ${
    isActive ? "bg-surface text-ink" : "text-muted hover:text-ink"
  }`;

/** Header property switcher: a dropdown with a search box for filtering long
 *  property lists. Picking a property submits a NATIVE form (not a React
 *  Router <Form>), so the switch is a full-document POST → the whole admin
 *  re-renders from fresh SSR under the new property cookie. A client-side
 *  navigation could leave the page showing the old property (stale
 *  uncontrolled inputs, or the Set-Cookie racing revalidation). */
function PropertySwitcher({
  properties,
  propertyId,
  pathname,
  t,
}: {
  properties: { id: string; name: string }[];
  propertyId?: string;
  pathname: string;
  t: AdminT;
}) {
  const current = properties.find((p) => p.id === propertyId);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const needle = q.trim().toLowerCase();
  const filtered = needle ? properties.filter((p) => p.name.toLowerCase().includes(needle)) : properties;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: string) => {
    if (id === propertyId) {
      setOpen(false);
      return;
    }
    if (pickRef.current) pickRef.current.value = id;
    // HTMLFormElement.submit() bypasses React Router — a real document POST.
    formRef.current?.submit();
  };

  return (
    <div ref={boxRef} className="relative">
      <form ref={formRef} method="post" action="/admin/select-property" className="hidden">
        <input type="hidden" name="redirectTo" value={pathname} />
        <input ref={pickRef} type="hidden" name="propertyId" value={propertyId ?? ""} />
      </form>
      <button
        type="button"
        onClick={() => {
          setQ("");
          setOpen((v) => !v);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("currentProperty")}
        className="flex max-w-[260px] items-center gap-1.5 rounded-[8px] border border-line-alt bg-surface px-2.5 py-1 text-[13px] font-semibold text-ink hover:border-accent"
      >
        <span className="truncate">{current?.name ?? t("selectProperty")}</span>
        <span aria-hidden="true" className={`text-[9px] text-muted transition-transform ${open ? "rotate-180" : ""}`}>
          ▼
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-40 mt-1.5 w-[280px] overflow-hidden rounded-[12px] border border-line bg-surface"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <div className="border-b border-divider p-2">
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered[0]) pick(filtered[0].id);
              }}
              placeholder={t("searchProperties")}
              aria-label={t("searchProperties")}
              className="w-full rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
          </div>
          <div className="max-h-[290px] overflow-y-auto p-1">
            {filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={p.id === propertyId}
                onClick={() => pick(p.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] ${
                  p.id === propertyId ? "bg-chip font-semibold text-ink" : "text-secondary hover:bg-surface-alt hover:text-ink"
                }`}
              >
                <span className="truncate">{p.name}</span>
                {p.id === propertyId && <span className="flex-none text-accent">✓</span>}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-3 text-center text-[12.5px] text-muted">{t("noPropertiesMatch", { q: q.trim() })}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { email, propertyId, properties, isSuperadmin, canManageCurrent, testMode, lang, languages, adminLang } =
    loaderData;
  const context: AdminContext = { propertyId, lang };
  const [navOpen, setNavOpen] = useState(true);
  const { pathname } = useLocation();
  const t = adminT(adminLang);

  // Nav is grouped into collapsible sections. Each starts collapsed; the section
  // holding the current page auto-expands so you never lose your place.
  interface NavItem {
    to: string;
    label: string;
    end?: boolean;
  }
  // Sections are keyed by a stable id (NOT the translated title) so the
  // open/closed state survives an admin-language switch.
  const sections: { id: string; title: string; items: NavItem[] }[] = [
    {
      id: "operations",
      title: t("navOperations"),
      items: [
        { to: "/admin/inventory", label: t("navInventory") },
        { to: "/admin/analytics", label: t("navAnalytics") },
        { to: "/admin/revenue", label: t("navRevenue") },
        { to: "/admin/rate-intel", label: t("navRateIntel") },
        { to: "/admin/ari-log", label: t("navChangeLog") },
        { to: "/admin/bookings", label: t("navBookings") },
        { to: "/admin/reviews", label: t("navReviews") },
      ],
    },
    {
      id: "settings",
      title: t("navSettings"),
      items: [
        // Property basics
        { to: "/admin", label: t("navPropertyDetails"), end: true },
        { to: "/admin/general", label: t("navGeneral") },
        { to: "/admin/portal", label: t("navPortal") },
        // Catalogue & pricing
        { to: "/admin/rooms", label: t("navRooms") },
        { to: "/admin/rates", label: t("navRates") },
        { to: "/admin/taxes", label: t("navTaxes") },
        { to: "/admin/promotions", label: t("navPromotions") },
        { to: "/admin/extras", label: t("navExtras") },
        { to: "/admin/vouchers", label: t("navVouchers") },
        // Integrations
        { to: "/admin/connectivity", label: t("navConnectivity") },
        { to: "/admin/google-hotels", label: t("navGoogle") },
        { to: "/admin/website-widget", label: t("navWidget") },
        { to: "/admin/brand-kit", label: t("navBrandKit") },
        { to: "/admin/payments", label: t("navPayments") },
        ...(canManageCurrent ? [{ to: "/admin/api-keys", label: t("navApiKeys") }] : []),
        ...(canManageCurrent ? [{ to: "/admin/webhooks", label: t("navWebhooks") }] : []),
        // Access & management
        ...(canManageCurrent ? [{ to: "/admin/team", label: t("navTeam") }] : []),
        { to: "/admin/properties", label: t("navProperties") },
        { to: "/admin/collections", label: t("navCollections") },
        ...(isSuperadmin ? [{ to: "/admin/users", label: t("navUsers") }] : []),
      ],
    },
    {
      id: "pages",
      title: t("navPages"),
      items: [
        { to: "/admin/home", label: t("navHome") },
        { to: "/admin/pages/results", label: t("navResults") },
        { to: "/admin/pages/detail", label: t("navRoomDetail") },
        { to: "/admin/pages/extras", label: t("navExtras") },
        { to: "/admin/pages/checkout", label: t("navCheckout") },
        { to: "/admin/pages/confirmation", label: t("navConfirmation") },
      ],
    },
    {
      id: "emails",
      title: t("navEmails"),
      items: [
        { to: "/admin/emails", label: t("navEmailSettings"), end: true },
        { to: "/admin/emails/booking_confirmation", label: t("navEmailBookingConfirmation") },
        { to: "/admin/emails/host_notification", label: t("navEmailHostNotification") },
        { to: "/admin/emails/booking_cancellation", label: t("navEmailBookingCancellation") },
        { to: "/admin/emails/cancellation_notification", label: t("navEmailCancellationNotification") },
        { to: "/admin/emails/booking_failed", label: t("navEmailBookingFailed") },
        { to: "/admin/emails/review_request", label: t("navEmailReviewRequest") },
      ],
    },
  ];
  const itemActive = (it: NavItem) =>
    it.end ? pathname === it.to : pathname === it.to || pathname.startsWith(`${it.to}/`);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sections.map((s) => [s.id, s.items.some(itemActive)])),
  );
  // Keep the section containing the current page open across client-side
  // navigations (without collapsing any the user opened themselves).
  useEffect(() => {
    const active = sections.find((s) => s.items.some(itemActive));
    if (active) setOpenSections((o) => (o[active.id] ? o : { ...o, [active.id]: true }));
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
              aria-label={navOpen ? t("hideMenu") : t("showMenu")}
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
              <PropertySwitcher properties={properties} propertyId={propertyId} pathname={pathname} t={t} />
            )}
            {languages.length > 1 && (
              <label className="flex items-center gap-1.5">
                <span className="text-faint">{t("editingLangLabel")}</span>
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
              // Prefer the slug — it's the address guests actually see/share.
              <Link
                to={`/${properties.find((p) => p.id === propertyId)?.slug || propertyId}`}
                className="hover:text-accent"
                target="_blank"
              >
                {t("viewSite")} ↗
              </Link>
            )}
            <Form method="post" action="/admin/lang" className="flex items-center">
              <input type="hidden" name="redirectTo" value={pathname} />
              <select
                name="lang"
                value={adminLang}
                onChange={(e) => e.currentTarget.form?.requestSubmit()}
                aria-label={t("adminLanguage")}
                title={t("adminLanguage")}
                className="cursor-pointer rounded-[8px] border border-line-alt bg-surface px-2 py-1 text-[13px] font-semibold text-ink outline-none focus:border-accent"
              >
                {ADMIN_LANGS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Form>
            <span>{email}</span>
            <Form method="post" action="/admin/logout">
              <button type="submit" className="font-semibold hover:text-accent">
                {t("signOut")}
              </button>
            </Form>
          </div>
        </div>
      </header>

      {testMode && (
        <div className="border-b border-amber-200 bg-amber-50">
          <div className={`flex ${shell} flex-wrap items-center justify-between gap-3 px-6 py-2.5`}>
            <span className="text-[13px] text-amber-900">
              <strong>{t("testModeTitle")}</strong> {t("testModeBody")}
            </span>
            <Link
              to="/admin/general"
              className="flex-none rounded-[8px] bg-amber-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-amber-700"
            >
              {t("activateLive")}
            </Link>
          </div>
        </div>
      )}

      <div className={`flex ${shell} gap-8 px-6 py-8`}>
        <nav className={`${navOpen ? "block" : "hidden"} w-44 flex-none space-y-1`}>
          {sections.map((section) => {
            const isOpen = openSections[section.id] ?? false;
            return (
              <div key={section.id}>
                <button
                  type="button"
                  onClick={() =>
                    setOpenSections((o) => ({ ...o, [section.id]: !(o[section.id] ?? false) }))
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
