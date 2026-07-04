// Brand kit: turns a property's live theme into a portable "style pack" so the
// hotel can build (or have AI build) a marketing website that matches their
// booking pages exactly — a copy-paste AI prompt plus drop-in brand.css and
// tokens.json. Everything here mirrors what property/layout.tsx + app.css render,
// so the exported values ARE what guests see on the booking engine.
import { getConfig } from "./config.server";
import { DEFAULT_THEME, THEMES, fontPair } from "./content";
import { getOverrides, getSettings } from "./overrides.server";

// Default font pair (FONT_PAIRS[0]) has no href — it's loaded in root.tsx. Give
// external sites the same Google Fonts URL so they render identical type.
const DEFAULT_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=Hanken+Grotesk:wght@400;500;600;700&display=swap";

// Per-theme accent-deep + page, mirroring the [data-theme] blocks in app.css.
// (accent itself comes from THEMES; soft/soft-strong are color-mix of accent.)
const THEME_DERIVED: Record<string, { deep: string; page: string }> = {
  terracotta: { deep: "oklch(0.55 0.14 45)", page: "#f7f2ec" },
  sage: { deep: "oklch(0.49 0.085 155)", page: "oklch(0.965 0.012 150)" },
  indigo: { deep: "oklch(0.46 0.11 268)", page: "oklch(0.966 0.009 280)" },
  ocean: { deep: "oklch(0.5 0.12 230)", page: "oklch(0.966 0.011 235)" },
  plum: { deep: "oklch(0.47 0.14 350)", page: "oklch(0.966 0.011 350)" },
};

// The fixed neutral palette + shadows (from the @theme block in app.css). These
// don't change per property — they're the booking engine's warm, editorial base.
const NEUTRALS: Record<string, string> = {
  surface: "#ffffff",
  "surface-alt": "#fffdfa",
  ink: "#2a2521",
  secondary: "#6f6557",
  muted: "#857a6c",
  "muted-2": "#9a8f80",
  faint: "#b1a799",
  line: "#efe7da",
  "line-alt": "#e3d9c9",
  divider: "#f0e8db",
  chip: "#f5efe5",
};
const SHADOW_CARD = "0 22px 50px -28px rgba(70, 55, 35, 0.35)";

export interface BrandTokens {
  accent: string;
  accentDeep: string;
  accentSoft: string;
  accentSoftStrong: string;
  page: string;
  neutrals: Record<string, string>;
  shadowCard: string;
  fonts: { heading: string; body: string; googleFontsHref: string };
  /** Corner-radius scale the booking engine uses (px), for reference. */
  radius: { card: string; button: string; input: string; pill: string };
}

function resolveTokens(
  accentIn: string | undefined,
  themeId: string | undefined,
  customBg: string | undefined,
  fontId: string | undefined,
): BrandTokens {
  const isCustom = themeId === "custom" && !!accentIn;
  const preset = THEMES.find((t) => t.id === themeId) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
  const accent = isCustom ? accentIn! : preset.accent;
  const accentDeep = isCustom
    ? `color-mix(in oklab, ${accent} 82%, black)`
    : (THEME_DERIVED[preset.id] ?? THEME_DERIVED[DEFAULT_THEME]).deep;
  const page = isCustom
    ? customBg || `color-mix(in oklab, ${accent} 7%, #ffffff)`
    : (THEME_DERIVED[preset.id] ?? THEME_DERIVED[DEFAULT_THEME]).page;
  const font = fontPair(fontId);
  return {
    accent,
    accentDeep,
    accentSoft: `color-mix(in oklab, ${accent} 12%, #ffffff)`,
    accentSoftStrong: `color-mix(in oklab, ${accent} 20%, #ffffff)`,
    page,
    neutrals: NEUTRALS,
    shadowCard: SHADOW_CARD,
    fonts: { heading: font.heading, body: font.body, googleFontsHref: font.href || DEFAULT_FONTS_HREF },
    radius: { card: "14px", button: "10px", input: "8px", pill: "999px" },
  };
}

/** A self-contained CSS file: font import + :root custom properties + a minimal
 *  base so headings/body/links/buttons match out of the box. Drop into any site. */
function brandCss(hotelName: string, t: BrandTokens): string {
  const neutralVars = Object.entries(t.neutrals)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n");
  return `/* ${hotelName} — brand tokens, matching the booking engine. */
@import url("${t.fonts.googleFontsHref}");

:root {
  --accent: ${t.accent};
  --accent-deep: ${t.accentDeep};
  --accent-soft: ${t.accentSoft};
  --accent-soft-strong: ${t.accentSoftStrong};
  --page: ${t.page};
${neutralVars}
  --shadow-card: ${t.shadowCard};
  --font-heading: ${t.fonts.heading};
  --font-body: ${t.fonts.body};
  --radius-card: ${t.radius.card};
  --radius-button: ${t.radius.button};
  --radius-input: ${t.radius.input};
  --radius-pill: ${t.radius.pill};
}

body {
  background: var(--page);
  color: var(--ink);
  font-family: var(--font-body);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { font-family: var(--font-heading); font-weight: 600; letter-spacing: -0.01em; color: var(--ink); }
a { color: var(--accent); }
a:hover { color: var(--accent-deep); }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-card); box-shadow: var(--shadow-card); }
.btn-primary { background: var(--accent); color: #fff; border-radius: var(--radius-button); padding: 12px 24px; font-weight: 600; border: 0; }
.btn-primary:hover { background: var(--accent-deep); }
.chip { background: var(--chip); border-radius: var(--radius-pill); padding: 2px 10px; font-size: 12px; color: var(--muted); }
`;
}

function brandJson(hotelName: string, t: BrandTokens): string {
  return JSON.stringify(
    {
      name: `${hotelName} brand tokens`,
      colors: {
        accent: t.accent,
        accentDeep: t.accentDeep,
        accentSoft: t.accentSoft,
        accentSoftStrong: t.accentSoftStrong,
        page: t.page,
        ...t.neutrals,
      },
      typography: {
        headingFontFamily: t.fonts.heading,
        bodyFontFamily: t.fonts.body,
        googleFontsHref: t.fonts.googleFontsHref,
      },
      radius: t.radius,
      shadow: { card: t.shadowCard },
    },
    null,
    2,
  );
}

/** The copy-paste AI prompt: everything an assistant needs to build a website
 *  in the same style, with the exact tokens inlined. */
function brandPrompt(hotelName: string, t: BrandTokens): string {
  return `You are building a marketing website for "${hotelName}". It must visually match our existing hotel booking engine so the two feel like one brand. Use the exact design tokens below — do not invent new colours or fonts.

## Fonts
Load this stylesheet in the <head>:
<link rel="stylesheet" href="${t.fonts.googleFontsHref}">
- Headings: ${t.fonts.heading}
- Body:     ${t.fonts.body}

## Colour tokens (CSS custom properties — use these verbatim)
--accent: ${t.accent};              /* primary buttons, links, active states */
--accent-deep: ${t.accentDeep};     /* hover on accent */
--accent-soft: ${t.accentSoft};     /* tinted backgrounds/badges */
--accent-soft-strong: ${t.accentSoftStrong};
--page: ${t.page};                  /* page background */
--surface: ${t.neutrals.surface};   /* cards */
--ink: ${t.neutrals.ink};           /* primary text */
--secondary: ${t.neutrals.secondary};
--muted: ${t.neutrals.muted};       /* secondary text */
--line: ${t.neutrals.line};         /* borders/dividers */
--chip: ${t.neutrals.chip};         /* pill backgrounds */

## Shape & shadow
- Card radius ${t.radius.card}, buttons ${t.radius.button}, inputs ${t.radius.input}, pills ${t.radius.pill} (fully rounded).
- Card shadow: ${t.shadowCard}
- Cards sit on --surface with a 1px --line border.

## Style direction
Warm, editorial, and calm — generous whitespace, large serif headings, restrained accent use (accent is for CTAs, links and small highlights, not big blocks). Buttons are solid --accent with white text; they darken to --accent-deep on hover. Prices/quality signals are understated. Mobile-first and responsive.

## Build
A clean, fast marketing site (home, rooms/gallery, about, contact). Prominent "Book now" buttons that link out to our booking engine. Keep the palette and type exactly as above so it's indistinguishable in style from the booking flow.`;
}

export interface BrandKit {
  hotelName: string;
  tokens: BrandTokens;
  css: string;
  json: string;
  prompt: string;
  bookingUrl: string;
}

/** Build the full brand kit for a property from its live theme settings. */
export async function buildBrandKit(pid: string): Promise<BrandKit> {
  const [settings, overrides] = await Promise.all([getSettings(pid), getOverrides(pid)]);
  const hotelName = overrides.hotelName || "Our hotel";
  const tokens = resolveTokens(settings.customColor, settings.theme, settings.customBg, settings.themeFont);
  const appUrl = getConfig().appUrl.replace(/\/+$/, "");
  return {
    hotelName,
    tokens,
    css: brandCss(hotelName, tokens),
    json: brandJson(hotelName, tokens),
    prompt: brandPrompt(hotelName, tokens),
    bookingUrl: `${appUrl}/${pid}`,
  };
}
