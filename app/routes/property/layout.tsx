import { useEffect } from "react";
import { Link, Outlet, useLocation, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/layout";
import { accessibleAccent, darkerAccent, mixWithWhite } from "~/lib/accessible-accent";
import type { PropertyOutletContext } from "~/lib/booking-context";
import {
  DEFAULT_LANG,
  DEFAULT_THEME,
  enabledLanguages,
  fontPair,
  langFromRequest,
  LANG_COOKIE,
} from "~/lib/content";
import { formatAddress } from "~/lib/address";
import { FontStylesheet } from "~/components/font-stylesheet";
import { LanguageSwitcher } from "~/components/language-switcher";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { getActiveVoucherProducts } from "~/lib/vouchers.server";
import { getSiteChrome } from "~/lib/site.server";
import { SiteFooterBlock } from "~/components/site-footer";
import type { ResolvedFooter } from "~/lib/footer";
import { getProperty } from "~/lib/properties.server";
import { propertyIdForHost } from "~/lib/domains.server";
import { makeTranslator, type Translator } from "~/lib/i18n";
import { basePath, useBase, useHome } from "~/lib/base";
import { resolveRequestProperty } from "~/lib/property-scope.server";

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
  if (!(await getProperty(pid))) {
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

  return {
    mode: "property" as const,
    property: { address: overrides.address, phone: overrides.phone, photos: [] },
    currency: settings.currency || "GBP",
    hotelName: overrides.hotelName || "Your hotel",
    logoImage: settings.logoImage || null,
    logoHideName: settings.logoHideName ?? false,
    // Auto-discovery: the "Gift vouchers" header link appears whenever the
    // property has something on sale (fail-open: a KV hiccup hides it).
    hasVouchers: await getActiveVoucherProducts(pid)
      .then((v) => v.length > 0)
      .catch(() => false),
    theme: settings.theme ?? DEFAULT_THEME,
    customColor: settings.customColor,
    customBg: settings.customBg,
    themeFont: settings.themeFont,
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
    { n: 1, label: tr.t(singleUnit ? "step_stay" : "step_room"), on: roomsOn || roomsDone },
    { n: 2, label: tr.t("step_details"), on: detOn || detDone },
    { n: 3, label: tr.t("step_confirmation"), on: conOn },
  ];
  const lines = [roomsDone, detDone];

  return (
    <div className="border-b border-nav-border bg-surface-alt">
      <div className="mx-auto flex max-w-[1160px] items-center gap-3.5 px-7 py-4 text-sm font-semibold">
        {steps.map((s, i) => (
          <div key={s.n} className="flex items-center gap-3.5">
            <span
              className="flex items-center gap-2.5"
              style={{ color: s.on ? "var(--color-ink)" : "var(--color-faint)" }}
            >
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full text-caption"
                style={{
                  background: s.on ? "var(--accent)" : "#efe7db",
                  color: s.on ? "#fff" : "var(--color-faint)",
                }}
              >
                {s.n}
              </span>
              {s.label}
            </span>
            {i < lines.length && (
              <span
                className="h-0.5 w-20 max-w-20 flex-1 rounded"
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

  const { property, currency, hotelName, logoImage, logoHideName, hasVouchers, theme, customColor, customBg, themeFont, singleUnit, lang, languages, websiteRooms, navPages, pageSlugs, footer, contact, termsUrl, privacyUrl } =
    loaderData;
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
  const isBrowsing = isHome || onWebsitePage || here.startsWith(`${base}/room/`);

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

  return (
    <div
      className="flex min-h-screen flex-col font-sans text-ink"
      data-theme={isCustom ? undefined : theme}
      style={themeStyle}
    >
      {/* Non-blocking, same as the default pair in root — see FontStylesheet.
          It's rendered here rather than in `links()` because the chosen pair only
          becomes known from loader data. */}
      <FontStylesheet href={font.href} />
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
                  <span className="font-serif text-title-lg font-semibold tracking-[-0.01em]">
                    {hotelName}
                  </span>
                )}
              </>
            ) : (
              <>
                <span
                  className="inline-block h-[13px] w-[13px] rounded-mark-lg bg-accent"
                  style={{ transform: "rotate(45deg)" }}
                />
                <span className="font-serif text-title-lg font-semibold tracking-[-0.01em]">
                  {hotelName}
                </span>
              </>
            )}
          </Link>
          {/* Wraps, and closes up its gaps on narrow screens: a hotel's own pages
              are in here too, so the link count isn't fixed — with four items it
              ran past the right edge of a phone and scrolled the whole page
              sideways. */}
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5 text-sm text-muted sm:gap-x-5">
            {languages.length > 1 && (
              <LanguageSwitcher languages={languages} current={lang} onSelect={changeLang} />
            )}
            {isBrowsing && websiteRooms && (
              <Link to={`${base}#rooms`} className="hover:text-accent">
                {tr.t("roomsNav")}
              </Link>
            )}
            {isBrowsing &&
              navPages.map((p) => (
                <Link key={p.slug} to={`${base}/p/${p.slug}`} className="hover:text-accent">
                  {p.label}
                </Link>
              ))}
            {isBrowsing && hasVouchers && (
              <Link to={`${base}/vouchers`} className="hover:text-accent">
                {tr.t("vouchersTitle")}
              </Link>
            )}
            {isBrowsing && (
              <Link to={`${base}/manage`} className="hover:text-accent">
                {tr.t("manageBooking")}
              </Link>
            )}
            {property.phone && <span className="hidden sm:inline">{property.phone}</span>}
          </div>
        </div>
      </header>

      {step !== "search" && <Stepper step={step} tr={tr} singleUnit={singleUnit} />}

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
            {tr.t("footerRight")}
            {/* Only on the shared domain. /admin is refused on a hotel's own
                hostname (requireCanonicalHost), so on a custom domain this was a
                dead link to our back office sitting on their public site.
                `params.channelId` is the tell: absent means the root mount. */}
            {isHome && params.channelId && (
              <>
                <span className="text-faint">·</span>
                <Link to="/admin" className="text-faint hover:text-accent">
                  {tr.t("admin")}
                </Link>
              </>
            )}
          </span>
        </div>
      </footer>
    </div>
  );
}
