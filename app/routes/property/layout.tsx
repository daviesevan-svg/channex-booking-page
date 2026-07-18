import { Link, Outlet, useLocation, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/layout";
import type { PropertyOutletContext } from "~/lib/booking-context";
import {
  DEFAULT_LANG,
  DEFAULT_THEME,
  enabledLanguages,
  fontPair,
  langFromRequest,
  LANG_COOKIE,
} from "~/lib/content";
import { LanguageSwitcher } from "~/components/language-switcher";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { getProperty, resolvePropertyId } from "~/lib/properties.server";
import { makeTranslator, type Translator } from "~/lib/i18n";

export async function loader({ params, request }: Route.LoaderArgs) {
  // Property details and currency come from the admin settings (no live Channex).
  // :channelId may be a slug — resolve it to the real id for data lookups; links
  // keep params.channelId so the slug stays in the URL through the flow.
  const lang = langFromRequest(request);
  const pid = await resolvePropertyId(params.channelId);
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

  return {
    property: { address: overrides.address, phone: overrides.phone, photos: [] },
    currency: settings.currency || "GBP",
    hotelName: overrides.hotelName || "Your hotel",
    logoImage: settings.logoImage || null,
    logoHideName: settings.logoHideName ?? false,
    theme: settings.theme ?? DEFAULT_THEME,
    customColor: settings.customColor,
    customBg: settings.customBg,
    themeFont: settings.themeFont,
    singleUnit: settings.singleUnit ?? false,
    lang,
    languages: enabledLanguages(settings),
  };
}

type Step = "search" | "results" | "detail" | "checkout" | "confirmation";

function useStep(channelId: string): Step {
  const { pathname } = useLocation();
  const rest = pathname.slice(`/${channelId}`.length).replace(/\/$/, "");
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
              style={{ color: s.on ? "var(--color-ink)" : "#b1a799" }}
            >
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full text-[13px]"
                style={{
                  background: s.on ? "var(--accent)" : "#efe7db",
                  color: s.on ? "#fff" : "#b1a799",
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
  const { property, currency, hotelName, logoImage, logoHideName, theme, customColor, customBg, themeFont, singleUnit, lang, languages } =
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
  const base = `/${params.channelId}`;
  // Only the landing page shows the "Manage booking" and "Admin" links, to keep
  // the search/checkout/manage screens focused.
  const { pathname } = useLocation();
  const isHome = pathname.replace(/\/$/, "") === base;

  const context: PropertyOutletContext = { property, currency, hotelName, lang };
  const navigation = useNavigation();
  const tr = makeTranslator(lang);

  const isCustom = theme === "custom" && !!customColor;
  const themeStyle = { background: "var(--page)" } as React.CSSProperties;
  if (isCustom) {
    Object.assign(themeStyle, {
      "--accent": customColor,
      "--accent-deep": `color-mix(in oklab, ${customColor} 82%, black)`,
      "--accent-soft": `color-mix(in oklab, ${customColor} 12%, #ffffff)`,
      "--accent-soft-strong": `color-mix(in oklab, ${customColor} 20%, #ffffff)`,
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
      {font.href && <link rel="stylesheet" href={font.href} />}
      {navigation.state !== "idle" && <div className="nav-progress" aria-hidden />}
      <header
        className="sticky top-0 z-20 border-b border-nav-border"
        style={{
          background: "color-mix(in oklab, var(--page) 82%, transparent)",
          backdropFilter: "blur(10px)",
        }}
      >
        <div className="mx-auto flex max-w-[1160px] items-center justify-between gap-4 px-7 py-4">
          <Link to={base} className="flex items-center gap-3">
            {logoImage ? (
              // The logo replaces the diamond mark. The hotel name stays beside
              // it by default; hide it (logoHideName) only for logos that already
              // read as a wordmark. Alt text keeps the name for accessibility.
              <>
                <img src={logoImage} alt={hotelName} className="h-10 w-auto max-w-[220px] object-contain" />
                {!logoHideName && (
                  <span className="font-serif text-[21px] font-semibold tracking-[-0.01em]">
                    {hotelName}
                  </span>
                )}
              </>
            ) : (
              <>
                <span
                  className="inline-block h-[13px] w-[13px] rounded-[2px] bg-accent"
                  style={{ transform: "rotate(45deg)" }}
                />
                <span className="font-serif text-[21px] font-semibold tracking-[-0.01em]">
                  {hotelName}
                </span>
              </>
            )}
          </Link>
          <div className="flex items-center gap-5 text-sm text-muted">
            {languages.length > 1 && (
              <LanguageSwitcher languages={languages} current={lang} onSelect={changeLang} />
            )}
            {isHome && (
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

      <footer className="border-t border-nav-border bg-surface-alt">
        <div className="mx-auto flex max-w-[1160px] flex-wrap items-center justify-between gap-4 px-7 py-[22px] text-[13px] text-muted-2">
          <span>© 2026 {hotelName} · {tr.t("allRightsReserved")}</span>
          <span className="flex items-center gap-2">
            {tr.t("footerRight")}
            {isHome && (
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
