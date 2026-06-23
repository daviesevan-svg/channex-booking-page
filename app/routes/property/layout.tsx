import { Link, Outlet, useLocation, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/layout";
import { ChannexApiError } from "~/lib/channex/client";
import type { PropertyOutletContext } from "~/lib/booking-context";
import { getChannexClient, getConfig } from "~/lib/config.server";
import { DEFAULT_LANG, DEFAULT_THEME, enabledLanguages, langFromRequest, langLabel } from "~/lib/content";
import { getOverrides, getSettings } from "~/lib/overrides.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const { channelCode } = getConfig();
  if (!channelCode) {
    throw new Response("CHANNEL_CODE is not configured", { status: 500 });
  }

  const client = getChannexClient();
  let property;
  try {
    property = await client.getPropertyInfo(params.channelId);
  } catch (error) {
    if (error instanceof ChannexApiError && error.status === 404) {
      throw new Response("Property not found", { status: 404 });
    }
    throw error;
  }

  // Apply admin content overrides (fall back to Channex when unset).
  const lang = langFromRequest(request);
  const [overrides, settings] = await Promise.all([
    getOverrides(params.channelId, lang),
    getSettings(params.channelId),
  ]);
  const merged = {
    ...property,
    title: overrides.hotelName || property.title,
    address: overrides.address || property.address,
    description: overrides.description || property.description,
    phone: overrides.phone || property.phone,
    email: overrides.email || property.email,
  };

  const currency = merged.currency || merged.hotelPolicy?.currency || "GBP";
  return {
    property: merged,
    currency,
    hotelName: merged.title,
    theme: settings.theme ?? DEFAULT_THEME,
    customColor: settings.customColor,
    customBg: settings.customBg,
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

function Stepper({ step }: { step: Step }) {
  const roomsOn = step === "results" || step === "detail";
  const roomsDone = step === "checkout" || step === "confirmation";
  const detOn = step === "checkout";
  const detDone = step === "confirmation";
  const conOn = step === "confirmation";

  const steps = [
    { n: 1, label: "Choose a room", on: roomsOn || roomsDone },
    { n: 2, label: "Your details", on: detOn || detDone },
    { n: 3, label: "Confirmation", on: conOn },
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
  const { property, currency, hotelName, theme, customColor, customBg, lang, languages } =
    loaderData;
  const [, setSearchParams] = useSearchParams();
  const changeLang = (code: string) =>
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (code === DEFAULT_LANG) p.delete("lang");
        else p.set("lang", code);
        return p;
      },
      { preventScrollReset: true },
    );
  const step = useStep(params.channelId);
  const base = `/${params.channelId}`;

  const context: PropertyOutletContext = { property, currency, hotelName };
  const navigation = useNavigation();

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

  return (
    <div
      className="flex min-h-screen flex-col font-sans text-ink"
      data-theme={isCustom ? undefined : theme}
      style={themeStyle}
    >
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
            <span
              className="inline-block h-[13px] w-[13px] rounded-[2px] bg-accent"
              style={{ transform: "rotate(45deg)" }}
            />
            <span className="font-serif text-[21px] font-semibold tracking-[-0.01em]">
              {hotelName}
            </span>
          </Link>
          <div className="flex items-center gap-5 text-sm text-muted">
            {languages.length > 1 && (
              <select
                value={lang}
                onChange={(e) => changeLang(e.target.value)}
                aria-label="Language"
                className="cursor-pointer rounded-[8px] border border-line-alt bg-surface-alt px-2 py-1 text-[13px] font-semibold text-secondary outline-none focus:border-accent"
              >
                {languages.map((code) => (
                  <option key={code} value={code}>
                    {langLabel(code)}
                  </option>
                ))}
              </select>
            )}
            <span className="cursor-pointer hover:text-accent">Manage booking</span>
            {property.phone && <span className="hidden sm:inline">{property.phone}</span>}
          </div>
        </div>
      </header>

      {step !== "search" && <Stepper step={step} />}

      <div className="flex-1">
        <Outlet context={context} />
      </div>

      <footer className="border-t border-nav-border bg-surface-alt">
        <div className="mx-auto flex max-w-[1160px] flex-wrap items-center justify-between gap-4 px-7 py-[22px] text-[13px] text-muted-2">
          <span>© 2026 {hotelName} · All rights reserved</span>
          <span className="flex items-center gap-2">
            Secure booking · Powered by Channex
            <span className="text-faint">·</span>
            <Link to="/admin" className="text-faint hover:text-accent">
              Admin
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
