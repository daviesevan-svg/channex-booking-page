// Editable page content (admin-overridable). Shared by the search screen and
// the admin editor so defaults stay in one place.

export interface Highlight {
  title: string;
  description: string;
}

export interface SearchContent {
  eyebrow?: string; // default derived from the property location
  heading?: string;
  intro?: string;
  promoText?: string;
  searchButton?: string;
  highlights?: Highlight[];
}

// ---- Editable copy for the remaining pages (flat string fields) ----
export interface PageField {
  key: string;
  label: string;
  textarea?: boolean;
  default: string;
}
export interface PageDef {
  id: string;
  label: string;
  fields: PageField[];
}

export const EDITABLE_PAGES: PageDef[] = [
  {
    id: "results",
    label: "Results",
    fields: [
      { key: "heading", label: "Heading", default: "Choose your rooms" },
      { key: "editSearch", label: "Edit-search button", default: "Edit search" },
      { key: "cartTitle", label: "Cart title", default: "Your stay" },
      { key: "continueButton", label: "Continue button", default: "Continue to details" },
    ],
  },
  {
    id: "detail",
    label: "Room detail",
    fields: [
      { key: "backLink", label: "Back link", default: "All rooms" },
      { key: "amenitiesTitle", label: "Amenities heading", default: "In this room" },
      { key: "rateTitle", label: "Rate card title", default: "Choose your rate" },
      { key: "addButton", label: "Add button", default: "Add to your stay" },
    ],
  },
  {
    id: "checkout",
    label: "Checkout",
    fields: [
      { key: "heading", label: "Heading", default: "Your details" },
      { key: "guestSection", label: "Guest section title", default: "Guest information" },
      { key: "arrivalSection", label: "Arrival section title", default: "Arrival & requests" },
      { key: "paymentSection", label: "Payment section title", default: "Payment" },
      {
        key: "paymentNote",
        label: "Payment note",
        textarea: true,
        default:
          "Your flexible rate is paid at the hotel. We only need a card to guarantee the booking — you won't be charged today.",
      },
      { key: "completeButton", label: "Complete button", default: "Complete booking" },
      {
        key: "cancellationNote",
        label: "Cancellation note",
        default: "Free cancellation until 24h before arrival.",
      },
    ],
  },
  {
    id: "confirmation",
    label: "Confirmation",
    fields: [
      { key: "heading", label: "Heading", default: "You're all set" },
      {
        key: "subtitle",
        label: "Subtitle ({hotel} = hotel name)",
        textarea: true,
        default: "Your stay at {hotel} is confirmed. A confirmation email is on its way.",
      },
      { key: "newBooking", label: "New-booking button", default: "Make another booking" },
    ],
  },
];

export function pageDef(id: string): PageDef | undefined {
  return EDITABLE_PAGES.find((p) => p.id === id);
}

/** Merge stored overrides over the page's defaults; always returns every field. */
export function withDefaults(
  id: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const def = pageDef(id);
  const out: Record<string, string> = {};
  if (def) for (const f of def.fields) out[f.key] = overrides[f.key]?.trim() || f.default;
  return out;
}

// Brand accent presets (map to [data-theme="…"] blocks in app.css).
export const THEMES = [
  { id: "terracotta", label: "Terracotta", accent: "oklch(0.63 0.13 45)" },
  { id: "sage", label: "Sage", accent: "oklch(0.57 0.075 155)" },
  { id: "indigo", label: "Indigo", accent: "oklch(0.54 0.10 268)" },
  { id: "ocean", label: "Ocean", accent: "oklch(0.58 0.11 230)" },
  { id: "plum", label: "Plum", accent: "oklch(0.55 0.13 350)" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const DEFAULT_THEME: ThemeId = "terracotta";

export function isThemeId(value: string): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export interface SiteSettings {
  theme?: ThemeId | "custom";
  customColor?: string;
  customBg?: string;
  customDomain?: string;
  languages?: string[]; // enabled languages (always includes the default)
}

// Supported content languages for the booking pages.
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "nl", label: "Nederlands" },
] as const;

export const DEFAULT_LANG = "en";

export function isLang(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code);
}

/** Validate a language code, falling back to the default. */
export function pickLang(code: string): string {
  return isLang(code) ? code : DEFAULT_LANG;
}

export const LANG_COOKIE = "ibe_lang";

/** Guest language: `?lang` wins, then the sticky `ibe_lang` cookie, then default. */
export function langFromRequest(request: Request): string {
  const param = new URL(request.url).searchParams.get("lang");
  if (param && isLang(param)) return param;
  const cookie = request.headers.get("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)ibe_lang=([^;]+)/);
  if (m && isLang(m[1])) return m[1];
  return DEFAULT_LANG;
}

/** Admin language: `?lang` only (independent of the guest cookie). */
export function langParam(request: Request): string {
  return pickLang(new URL(request.url).searchParams.get("lang") ?? "");
}

export function langLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

/** Enabled languages from settings — always includes the default, only valid codes. */
export function enabledLanguages(settings: SiteSettings): string[] {
  const set = new Set([DEFAULT_LANG, ...(settings.languages ?? []).filter(isLang)]);
  // preserve LANGUAGES order
  return LANGUAGES.map((l) => l.code).filter((c) => set.has(c));
}

/** Returns a normalized #rrggbb / #rgb hex, or undefined if invalid. */
export function normalizeHex(value: string): string | undefined {
  const s = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s.toLowerCase() : undefined;
}

export const DEFAULT_SEARCH = {
  heading: "Reserve your stay",
  intro:
    "Book direct for our best available rates, free cancellation on flexible bookings, and absolutely no booking fees — every time.",
  promoText: "Add a promo or corporate code",
  searchButton: "Search rooms",
  highlights: [
    { title: "Free cancellation", description: "On all flexible rates, up to 24h before arrival." },
    { title: "Best rate, guaranteed", description: "Lower price elsewhere? We'll match it." },
    { title: "No booking fees", description: "The price you see is the price you pay." },
  ] as Highlight[],
};
