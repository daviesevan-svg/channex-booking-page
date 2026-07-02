import { Outlet } from "react-router";

import type { Route } from "./+types/embed.$channelId";
import type { PropertyOutletContext } from "~/lib/booking-context";
import { DEFAULT_THEME, langFromRequest } from "~/lib/content";
import { getOverrides, getSettings } from "~/lib/overrides.server";

// Bare, chrome-less shell for the embeddable widget iframe (/embed/:channelId).
// It provides the same Outlet context the property pages do (so shared bits like
// GuestSelector/CalendarPopover work) and applies the property's theme — but no
// header/footer/stepper. Deliberately does NOT read ARI: it depends only on the
// (rarely-changing) theme, so the response is cacheable and cheap per impression.
export async function loader({ params, request }: Route.LoaderArgs) {
  const lang = langFromRequest(request);
  const [overrides, settings] = await Promise.all([
    getOverrides(params.channelId, lang),
    getSettings(params.channelId),
  ]);
  return {
    currency: settings.currency || "GBP",
    hotelName: overrides.hotelName || "Your hotel",
    theme: settings.theme ?? DEFAULT_THEME,
    customColor: settings.customColor,
    customBg: settings.customBg,
    lang,
  };
}

// Let hotel sites frame this page, and let the edge cache it (it's the same for
// every visitor of a property — no per-user data).
export function headers() {
  return { "Cache-Control": "public, max-age=300" };
}

export default function EmbedLayout({ loaderData }: Route.ComponentProps) {
  const { currency, hotelName, theme, customColor, customBg, lang } = loaderData;

  const isCustom = theme === "custom" && !!customColor;
  const themeStyle = { background: "transparent" } as React.CSSProperties;
  if (isCustom) {
    Object.assign(themeStyle, {
      "--accent": customColor,
      "--accent-deep": `color-mix(in oklab, ${customColor} 82%, black)`,
      "--accent-soft": `color-mix(in oklab, ${customColor} 12%, #ffffff)`,
      "--accent-soft-strong": `color-mix(in oklab, ${customColor} 20%, #ffffff)`,
      "--page": customBg || `color-mix(in oklab, ${customColor} 7%, #ffffff)`,
    });
  }

  const context: PropertyOutletContext = {
    property: { photos: [] },
    currency,
    hotelName,
    lang,
  };

  return (
    <div className="font-sans text-ink" data-theme={isCustom ? undefined : theme} style={themeStyle}>
      <Outlet context={context} />
    </div>
  );
}
