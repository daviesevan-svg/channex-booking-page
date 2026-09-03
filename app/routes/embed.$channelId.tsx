import { Outlet } from "react-router";

import type { Route } from "./+types/embed.$channelId";
import { FontFaces } from "~/components/font-faces";
import { accentColors, mixWithWhite } from "~/lib/accessible-accent";
import type { PropertyOutletContext } from "~/lib/booking-context";
import { DEFAULT_THEME, fontPair, langFromRequest } from "~/lib/content";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { resolveRequestProperty } from "~/lib/property-scope.server";

// Bare, chrome-less shell for the embeddable widget iframe (/embed/:channelId).
// It provides the same Outlet context the property pages do (so shared bits like
// GuestSelector/CalendarPopover work) and applies the property's theme — but no
// header/footer/stepper. Deliberately does NOT read ARI: it depends only on the
// (rarely-changing) theme, so the response is cacheable and cheap per impression.
export async function loader({ params, request }: Route.LoaderArgs) {
  const lang = langFromRequest(request);
  // :channelId may be a slug — resolve to the real id for the theme lookup.
  // Host-disciplined like every slug mount (property-scope.server.ts): on our
  // shared domain any property embeds; on a white-label partner's guest host
  // only that partner's properties do; anywhere else this route is a 404. The
  // widget snippet serves from the property's own brand host, so a foreign
  // tenant's widget must not render under it.
  const pid = await resolveRequestProperty(params.channelId, request);
  const [overrides, settings] = await Promise.all([
    getOverrides(pid, lang),
    getSettings(pid),
  ]);
  return {
    currency: settings.currency || "GBP",
    hotelName: overrides.hotelName || "Your hotel",
    theme: settings.theme ?? DEFAULT_THEME,
    customColor: settings.customColor,
    customBg: settings.customBg,
    themeFont: settings.themeFont,
    lang,
  };
}

// Let hotel sites frame this page, and let the edge cache it (it's the same for
// every visitor of a property — no per-user data).
export function headers() {
  return { "Cache-Control": "public, max-age=300" };
}

export default function EmbedLayout({ loaderData }: Route.ComponentProps) {
  const { currency, hotelName, theme, customColor, customBg, themeFont, lang } = loaderData;
  const font = fontPair(themeFont);

  const isCustom = theme === "custom" && !!customColor;
  const themeStyle = { background: "transparent" } as React.CSSProperties;
  if (isCustom) {
    // The chosen colour, moved only as far as legibility needs — and the colour
    // to write ON it, which is picked rather than assumed to be white. See
    // accessible-accent.ts.
    const { accent, onAccent, deep } = accentColors(customColor!, customBg || mixWithWhite(customColor!, 7), "#ffffff");
    Object.assign(themeStyle, {
      "--accent": accent,
      "--accent-deep": deep,
      "--on-accent": onAccent,
      // 8%, matching the named themes: at 12% `text-accent` on a soft background
      // came out at 4.36:1.
      "--accent-soft": `color-mix(in oklab, ${accent} 8%, #ffffff)`,
      "--accent-soft-strong": `color-mix(in oklab, ${accent} 20%, #ffffff)`,
      "--page": customBg || `color-mix(in oklab, ${customColor} 7%, #ffffff)`,
    });
  }
  if (font.id !== "default") {
    Object.assign(themeStyle, { "--font-serif": font.heading, "--font-sans": font.body });
  }

  const context: PropertyOutletContext = {
    property: { photos: [] },
    currency,
    hotelName,
    lang,
  };

  return (
    <div className="font-sans text-ink" data-theme={isCustom ? undefined : theme} style={themeStyle}>
      {/* Inline @font-face for the chosen pair, served from our own origin —
          see FontFaces. Rendered here rather than in `links()` because the pair
          only becomes known from loader data. */}
      <FontFaces pair={font.id} />
      <Outlet context={context} />
    </div>
  );
}
