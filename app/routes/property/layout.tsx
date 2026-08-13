import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigation,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import type { Route } from "./+types/layout";
import { accessibleAccent, darkerAccent, mixWithWhite } from "~/lib/accessible-accent";
import type { PropertyOutletContext } from "~/lib/booking-context";
import {
  DEFAULT_LANG,
  DEFAULT_THEME,
  enabledLanguages,
  fontPair,
  isFontPairId,
  langFromRequest,
  LANG_COOKIE,
} from "~/lib/content";
import { formatAddress } from "~/lib/address";
import { FontStylesheet } from "~/components/font-stylesheet";
import { LanguageSwitcher } from "~/components/language-switcher";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { getPublicOffers } from "~/lib/promotions.server";
import { getActiveVoucherProducts } from "~/lib/vouchers.server";
import { getSiteChrome } from "~/lib/site.server";
import { SiteFooterBlock } from "~/components/site-footer";
import { SiteStyleProvider } from "~/components/site-style";
import { isSiteStyleId, siteStyle } from "~/lib/site-style";
import type { ResolvedFooter } from "~/lib/footer";
import { getProperty } from "~/lib/properties.server";
import { DEFAULT_BRAND, getPartner } from "~/lib/partners.server";
import { propertyIdForHost } from "~/lib/domains.server";
import { makeTranslator, type Translator } from "~/lib/i18n";
import { basePath, useBase, useHome } from "~/lib/base";
import { resolveRequestProperty } from "~/lib/property-scope.server";
import { getAdminEmail } from "~/lib/auth.server";

/** The booking funnel carries its state in search params (dates, occupancy,
 *  cart, extras), so by default this layout's loader re-ran on EVERY funnel
 *  step — re-reading chrome, footer, vouchers and offers that only depend on
 *  the property and language. That was most of the KV traffic behind "select a
 *  rate → wait". Only re-run for the inputs the loader actually reads: the
 *  property segment, the language, the admin design-preview params — and any
 *  mutation, which may have changed the underlying content. */
export function shouldRevalidate({
  currentParams,
  nextParams,
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentParams.channelId !== nextParams.channelId) return true;
  for (const p of ["lang", "style", "font"]) {
    if (currentUrl.searchParams.get(p) !== nextUrl.searchParams.get(p)) return true;
  }
  return false;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  // Property details and currency come from the admin settings (no live Channex).
  // :channelId may be a slug — resolve it to the real id for data lookups; links
  // keep params.channelId so the slug stays in the URL through the flow.
  const lang = langFromRequest(request);

  // This layout serves BOTH mounts. With a path segment the property comes from
  // it; at the root it comes from the hostname (a hotel's own domain). The
  // hostname is only consulted when there is no segment, so the shared domain
  // does no extra lookup.
  const pid = params.channelId
    ? await resolveRequestProperty(params.channelId, request)
    : ((await propertyIdForHost(new URL(request.url).hostname)) ?? "");

  // Root mount on a hostname that isn't a custom domain: this is the shared
  // domain's own front door. Render nothing but an Outlet — the child is the
  // property picker, which must not be wrapped in some hotel's branding.
  if (!pid) return { mode: "passthrough" as const };
  // A property that isn't in the registry (never existed, or was deleted) must
  // 404 — its KV data can linger after removal, so we gate on the registry, not
  // on whether settings/overrides happen to still be readable.
  const ref = await getProperty(pid);
  if (!ref) {
    throw new Response("Property not found", { status: 404 });
  }
  const [overrides, settings] = await Promise.all([
    getOverrides(pid, lang),
    getSettings(pid),
  ]);
  // One read for both bits of website chrome. The "Rooms" nav link only appears
  // when the home page actually has a visible rooms section — a nav link to
  // nothing is worse than no nav link.
  const chrome = settings.websiteEnabled
    ? await getSiteChrome(pid, lang).catch(() => null)
    : null;

  // Preview: the design screen renders this page in an iframe with the template
  // and typeface the operator is CONSIDERING, before anything is saved.
  //
  // Gated on a signed-in admin, so a link with `?style=` on it shows a guest
  // exactly what the property stored. Presentation-only either way — every value
  // comes from our own tables — but a hotel's shared link should never render as
  // a design they didn't choose. The session is only read when a param is
  // present, so ordinary traffic pays nothing.
  // Auto-discovery for two header links, one KV read each and neither waiting on
  // the other: "Gift vouchers" whenever the property has something on sale, and
  // "Offers" whenever it has a published promotion. Both fail open to hidden — a
  // KV hiccup should cost a nav link, not the page.
  const [hasVouchers, hasOffers] = await Promise.all([
    getActiveVoucherProducts(pid)
      .then((v) => v.length > 0)
      .catch(() => false),
    // Website-only, because the offers page itself 404s with the website off —
    // otherwise this would be a link to a 404.
    settings.websiteEnabled
      ? getPublicOffers(pid).then((o) => o.length > 0)
      : Promise.resolve(false),
  ]);

  const url = new URL(request.url);
  // Footer attribution and the back-office link follow the PROPERTY's partner,
  // the same rule as every operator-facing link (guestHostForProperty): a
  // white-label hotel's public page must not carry our name, and /admin is a
  // 404 on a partner's guest host — their back office lives on the partner's
  // own admin host. No partner admin host = no link at all, rather than one
  // pointing at our brand. Same scheme/port as this request so dev works.
  const partner = await getPartner(ref.partnerId);
  const footerBrand = partner?.brandName ?? DEFAULT_BRAND.name;
  const adminHref = partner
    ? partner.adminHost
      ? `${url.protocol}//${partner.adminHost}${url.port ? `:${url.port}` : ""}/admin`
      : null
    : "/admin";
  const wantStyle = url.searchParams.get("style");
  const wantFont = url.searchParams.get("font");
  const preview =
    (wantStyle || wantFont) && (await getAdminEmail(request))
      ? {
          style: wantStyle && isSiteStyleId(wantStyle) ? wantStyle : null,
          font: wantFont && isFontPairId(wantFont) ? wantFont : null,
        }
      : null;

  return {
    mode: "property" as const,
    property: { address: overrides.address, phone: overrides.phone, photos: [] },
    currency: settings.currency || "GBP",
    hotelName: overrides.hotelName || "Your hotel",
    logoImage: settings.logoImage || null,
    logoHideName: settings.logoHideName ?? false,
    faviconImage: settings.faviconImage || null,
    hasVouchers,
    hasOffers,
    theme: settings.theme ?? DEFAULT_THEME,
    customColor: settings.customColor,
    customBg: settings.customBg,
    themeFont: preview?.font ?? settings.themeFont,
    singleUnit: settings.singleUnit ?? false,
    lang,
    languages: enabledLanguages(settings),
    websiteRooms: chrome?.hasRoomsSection ?? false,
    // Extra pages the hotel put in the menu, and every extra page's slug — the
    // second is what tells the layout it's ON a website page, so the browsing
    // nav stays visible even on a page deliberately kept out of the menu.
    navPages: chrome?.navPages ?? [],
    pageSlugs: chrome?.pageSlugs ?? [],
    footer: chrome?.footer ?? null,
    // Which layout style the website pages render with. Null with the website
    // off, which resolves to `classic` — the legacy booking page's look, and the
    // only one it has ever had.
    siteStyle: preview?.style ?? chrome?.style ?? null,
    contact: {
      // Full postal address, not just the street line — same fix as the map and
      // contact sections.
      address: formatAddress({
        address: overrides.address,
        city: settings.addressCity,
        region: settings.addressRegion,
        postalCode: settings.addressPostalCode,
        country: settings.addressCountry,
      }),
      phone: overrides.phone,
      email: overrides.email,
    },
    termsUrl: settings.termsUrl ?? null,
    privacyUrl: settings.privacyUrl ?? null,
    footerBrand,
    adminHref,
  };
}

type Step = "search" | "results" | "detail" | "checkout" | "confirmation";

function useStep(channelId: string | undefined): Step {
  const { pathname } = useLocation();
  const rest = pathname.slice(basePath(channelId).length).replace(/\/$/, "");
  if (rest === "") return "search";
  if (rest.startsWith("/rooms/")) return "detail";
  if (rest === "/rooms") return "results";
  if (rest.startsWith("/checkout")) return "checkout";
  if (rest.startsWith("/confirmation")) return "confirmation";
  return "search";
}

function Stepper({ step, tr, singleUnit }: { step: Step; tr: Translator; singleUnit: boolean }) {
  const roomsOn = step === "results" || step === "detail";
  const roomsDone = step === "checkout" || step === "confirmation";
  const detOn = step === "checkout";
  const detDone = step === "confirmation";
  const conOn = step === "confirmation";

  const steps = [
    { n: 1, label: tr.t(singleUnit ? "step_stay" : "step_room"), on: roomsOn || roomsDone, here: roomsOn },
    { n: 2, label: tr.t("step_details"), on: detOn || detDone, here: detOn },
    { n: 3, label: tr.t("step_confirmation"), on: conOn, here: conOn },
  ];
  const lines = [roomsDone, detDone];

  // All three labels laid out side by side need ~520px, so on any phone the row
  // used to run off the edge and take the whole document with it — every funnel
  // page scrolled sideways and step 3 sat off-screen. Below `sm` only the step
  // you're on is labelled (the numbered circles carry the rest) and the
  // connectors shrink, which brings the row under 320px.
  return (
    <div className="border-b border-nav-border bg-surface-alt">
      <div className="mx-auto flex max-w-[1160px] items-center gap-2.5 px-4 py-4 text-sm font-semibold sm:gap-3.5 sm:px-7">
        {steps.map((s, i) => (
          <div key={s.n} className="flex min-w-0 items-center gap-2.5 sm:gap-3.5">
            <span
              className="flex min-w-0 items-center gap-2.5"
              style={{ color: s.on ? "var(--color-ink)" : "var(--color-faint)" }}
            >
              <span
                className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-caption"
                style={{
                  background: s.on ? "var(--accent)" : "#efe7db",
                  color: s.on ? "#fff" : "var(--color-faint)",
                }}
              >
                {s.n}
              </span>
              <span className={`truncate ${s.here ? "" : "hidden sm:inline"}`}>{s.label}</span>
            </span>
            {i < lines.length && (
              <span
                className="h-0.5 w-6 min-w-3 flex-1 rounded sm:w-20 sm:max-w-20"
                style={{ background: lines[i] ? "var(--accent)" : "#e6ddd2" }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PropertyLayout({ loaderData, params }: Route.ComponentProps) {
  // Root mount on the shared domain: no property, so no chrome. The child is the
  // picker, which brings its own. Bare Outlet rather than a 404 — "/" is a real
  // page here, just not a hotel's.
  if (loaderData.mode === "passthrough") return <Outlet />;

  const { property, currency, hotelName, logoImage, logoHideName, faviconImage, hasVouchers, hasOffers, theme, customColor, customBg, themeFont, singleUnit, lang, languages, websiteRooms, navPages, pageSlugs, footer, siteStyle: siteStyleId, contact, termsUrl, privacyUrl, footerBrand, adminHref } =
    loaderData;
  // Resolved once: its token overrides go on the wrapper below, and the same
  // definition is what the provider hands the section renderer.
  const style = siteStyle(siteStyleId ?? undefined);
  const font = fontPair(themeFont);
  const [, setSearchParams] = useSearchParams();
  const changeLang = (code: string) => {
    // Persist as a cookie so the choice survives navigations that drop ?lang.
    document.cookie = `${LANG_COOKIE}=${code}; path=/; max-age=${
      code === DEFAULT_LANG ? 0 : 60 * 60 * 24 * 365
    }`;
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (code === DEFAULT_LANG) p.delete("lang");
        else p.set("lang", code);
        return p;
      },
      { preventScrollReset: true },
    );
  };
  const step = useStep(params.channelId);
  const base = useBase();
  const home = useHome();
  // The "Manage booking" / "Gift vouchers" links belong on pages a guest is
  // BROWSING, not on the funnel steps, which stay focused. That's the landing
  // page plus the website's room pages — a room page is somewhere you look
  // around, so hiding the nav there would be a dead end with only Back.
  const { pathname, hash } = useLocation();
  const here = pathname.replace(/\/$/, "");
  const isHome = here === base;
  // An extra website page is somewhere a guest looks around, like a room page —
  // so the browsing nav belongs there too.
  const onWebsitePage = pageSlugs.some((s) => here === `${base}/p/${s}`);
  // The offers list AND one offer's page, hence the prefix rather than an equality
  // check — an offer page is somewhere a guest looks around, like a room page, so
  // hiding the nav there would be a dead end with only Back.
  // The voucher pages are browsing too — a guest reads what's on offer there and
  // may well decide not to buy, and the logo-only header left them with no route
  // to the rooms, the offers or their booking.
  const isBrowsing =
    isHome ||
    onWebsitePage ||
    here.startsWith(`${base}/offers`) ||
    here.startsWith(`${base}/room/`) ||
    here.startsWith(`${base}/vouchers`);

  // React Router doesn't scroll to a #fragment on navigation, so the "Rooms"
  // link would change the URL and sit still. Sections carry scroll-mt for the
  // sticky header.
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pathname, hash]);

  const context: PropertyOutletContext = { property, currency, hotelName, lang };
  const navigation = useNavigation();
  const tr = makeTranslator(lang);

  // One list, rendered twice: inline from `sm` up, and inside the phone menu
  // below it. Built here so the two can't drift apart.
  const navItems = isBrowsing
    ? [
        ...(websiteRooms ? [{ to: `${base}#rooms`, label: tr.t("roomsNav") }] : []),
        ...(hasOffers ? [{ to: `${base}/offers`, label: tr.t("offersNav") }] : []),
        ...navPages.map((p) => ({ to: `${base}/p/${p.slug}`, label: p.label })),
        ...(hasVouchers ? [{ to: `${base}/vouchers`, label: tr.t("vouchersTitle") }] : []),
        { to: `${base}/manage`, label: tr.t("manageBooking") },
      ]
    : [];
  // Phones get a disclosure instead of the wrapped link row: five links wrapped
  // onto two lines and squeezed the hotel name into two, and the phone number was
  // dropped entirely at exactly the width where tapping to call matters most.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  const telHref = property.phone ? `tel:${property.phone.replace(/[^+\d]/g, "")}` : null;
  const hasMenu = navItems.length > 0 || Boolean(telHref);

  const isCustom = theme === "custom" && !!customColor;
  const themeStyle = { background: "var(--page)" } as React.CSSProperties;
  if (isCustom) {
    // The chosen colour, darkened only if it can't carry white text or be read as
    // a link. Spilman's #b5651d gave 4.34:1 under white and 3.98:1 on the page —
    // the audit flagged both. See accessible-accent.ts.
    const accent = accessibleAccent(customColor!, customBg || mixWithWhite(customColor!, 7));
    Object.assign(themeStyle, {
      "--accent": accent,
      "--accent-deep": darkerAccent(accent),
      // 8%, matching the named themes: at 12% `text-accent` on a soft background
      // came out at 4.36:1.
      "--accent-soft": `color-mix(in oklab, ${accent} 8%, #ffffff)`,
      "--accent-soft-strong": `color-mix(in oklab, ${accent} 20%, #ffffff)`,
      "--page": customBg || `color-mix(in oklab, ${customColor} 7%, #ffffff)`,
    });
  }
  // Chosen font pairing (default = the fonts already loaded in root.tsx).
  if (font.id !== "default") {
    Object.assign(themeStyle, { "--font-serif": font.heading, "--font-sans": font.body });
  }
  // The template's token overrides, on the wrapper around EVERY guest page — so
  // the template carries through the whole journey, funnel and voucher flow and
  // manage pages included. They draw their corners and type sizes from these
  // tokens, so this needs no change at any of those call sites.
  //
  // Last, so a style could override a theme value; nothing does today, and a
  // style fighting the theme's accent would be a bug rather than a feature.
  Object.assign(themeStyle, style.vars ?? {}, style.headings ?? {});

  return (
    <SiteStyleProvider id={siteStyleId ?? undefined}>
    <div
      className="flex min-h-screen flex-col font-sans text-ink"
      data-theme={isCustom ? undefined : theme}
      data-style={style.id}
      // Switches on the generic heading rule in app.css. Present only for a
      // style that declares heading typography, so `classic` keeps the
      // per-call-site utilities it has always had.
      data-headings={style.headings ? "" : undefined}
      style={themeStyle}
    >
      {/* Non-blocking, same as the default pair in root — see FontStylesheet.
          It's rendered here rather than in `links()` because the chosen pair only
          becomes known from loader data. */}
      <FontStylesheet href={font.href} />
      {/* The hotel's own tab icon. Rendered here, not in root: root resolves a
          favicon from the HOSTNAME (a partner's), and only this layout knows
          which property the request is for — resolving it up there would mean
          re-deriving the property and two more KV reads on every guest page.
          React hoists it into <head>, and being emitted after root's it also
          wins over a white-label partner's icon on a property page, which is
          the precedence we want: the tab belongs to the hotel. */}
      {faviconImage && <link rel="icon" href={faviconImage} />}
      {navigation.state !== "idle" && <div className="nav-progress" aria-hidden />}
      <header
        className="sticky top-0 z-20 border-b border-nav-border"
        style={{
          background: "color-mix(in oklab, var(--page) 82%, transparent)",
          backdropFilter: "blur(10px)",
        }}
      >
        <div className="mx-auto flex max-w-[1160px] items-center justify-between gap-4 px-7 py-4">
          <Link to={home} className="flex items-center gap-3">
            {logoImage ? (
              // The logo replaces the diamond mark. The hotel name stays beside
              // it by default; hide it (logoHideName) only for logos that already
              // read as a wordmark. Alt text keeps the name for accessibility.
              <>
                <img src={logoImage} alt={hotelName} className="h-10 w-auto max-w-[220px] object-contain" />
                {!logoHideName && (
                  <span className="wordmark font-serif text-title-md font-semibold tracking-[-0.01em]">
                    {hotelName}
                  </span>
                )}
              </>
            ) : (
              <>
                <span
                  className="inline-block h-[13px] w-[13px] rounded-mark bg-accent"
                  style={{ transform: "rotate(45deg)" }}
                />
                <span className="wordmark font-serif text-title-md font-semibold tracking-[-0.01em]">
                  {hotelName}
                </span>
              </>
            )}
          </Link>
          {/* Wraps, and closes up its gaps on narrow screens: a hotel's own pages
              are in here too, so the link count isn't fixed. */}
          <div className="hidden flex-wrap items-center justify-end gap-x-4 gap-y-1.5 text-sm text-muted sm:flex sm:gap-x-5">
            {languages.length > 1 && (
              <LanguageSwitcher languages={languages} current={lang} onSelect={changeLang} />
            )}
            {navItems.map((item) => (
              <Link key={item.to} to={item.to} className="hover:text-accent">
                {item.label}
              </Link>
            ))}
            {telHref && (
              <a href={telHref} className="hover:text-accent">
                {property.phone}
              </a>
            )}
          </div>

          {/* Phone header: the language switcher stays out in the open (it changes
              what the whole page says), everything else goes behind the menu. */}
          <div className="flex items-center gap-2 sm:hidden">
            {languages.length > 1 && (
              <LanguageSwitcher languages={languages} current={lang} onSelect={changeLang} />
            )}
            {hasMenu && (
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-label={tr.t("menu")}
                className="flex h-11 w-11 flex-none items-center justify-center rounded-control border border-line-alt text-lg leading-none text-muted"
              >
                {menuOpen ? "✕" : "☰"}
              </button>
            )}
          </div>
        </div>

        {menuOpen && (
          <div className="border-t border-nav-border sm:hidden" style={{ background: "var(--page)" }}>
            <nav className="mx-auto flex max-w-[1160px] flex-col px-7 py-2 text-sm">
              {navItems.map((item) => (
                <Link key={item.to} to={item.to} className="border-b border-divider py-3 text-ink last:border-0">
                  {item.label}
                </Link>
              ))}
              {telHref && (
                <a href={telHref} className="border-b border-divider py-3 font-semibold text-accent last:border-0">
                  {property.phone}
                </a>
              )}
            </nav>
          </div>
        )}
      </header>

      {step !== "search" && <Stepper step={step} tr={tr} singleUnit={singleUnit} />}

      {/* The provider wraps the header and footer too, not just the Outlet: they
          are part of the journey a guest sees, and a template that stopped at the
          content was the whole complaint. It emits no markup. */}
      <div className="flex-1">
        <Outlet context={context} />
      </div>

      {/* Not on checkout or confirmation. The header's nav is already hidden on
          those steps to keep them focused; a footer full of social links and
          "Rooms" is the same exit risk at the worst possible moment. */}
      {footer && step !== "checkout" && step !== "confirmation" && (
        <SiteFooterBlock
          footer={footer as ResolvedFooter}
          contact={contact}
          hotelName={hotelName}
          links={[
            ...(websiteRooms ? [{ label: tr.t("roomsNav"), to: `${base}#rooms` }] : []),
            ...(hasOffers ? [{ label: tr.t("offersNav"), to: `${base}/offers` }] : []),
            ...navPages.map((p) => ({ label: p.label, to: `${base}/p/${p.slug}` })),
            ...(hasVouchers ? [{ label: tr.t("vouchersTitle"), to: `${base}/vouchers` }] : []),
            { label: tr.t("manageBooking"), to: `${base}/manage` },
            ...(termsUrl ? [{ label: tr.t("termsLink"), to: termsUrl, external: true }] : []),
            ...(privacyUrl ? [{ label: tr.t("privacyLink"), to: privacyUrl, external: true }] : []),
          ]}
          tr={tr}
        />
      )}

      <footer className="border-t border-nav-border bg-surface-alt">
        <div className="mx-auto flex max-w-[1160px] flex-wrap items-center justify-between gap-4 px-7 py-[22px] text-caption text-muted-2">
          <span>© 2026 {hotelName} · {tr.t("allRightsReserved")}</span>
          <span className="flex items-center gap-2">
            {tr.t("footerRight", { brand: footerBrand })}
            {/* Only on the shared domain. /admin is refused on a hotel's own
                hostname (requireCanonicalHost), so on a custom domain this was a
                dead link to our back office sitting on their public site.
                `params.channelId` is the tell: absent means the root mount.
                `adminHref` is absolute for a partner property (their own admin
                host) and null when a partner has none — see the loader. */}
            {isHome && params.channelId && adminHref && (
              <>
                <span className="text-faint">·</span>
                {adminHref.startsWith("http") ? (
                  // Cross-origin: a router Link would try to navigate in-app.
                  <a href={adminHref} className="text-faint hover:text-accent">
                    {tr.t("admin")}
                  </a>
                ) : (
                  <Link to={adminHref} className="text-faint hover:text-accent">
                    {tr.t("admin")}
                  </Link>
                )}
              </>
            )}
          </span>
        </div>
      </footer>
    </div>
    </SiteStyleProvider>
  );
}
