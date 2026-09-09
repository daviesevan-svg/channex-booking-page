// Editable page content (admin-overridable). Shared by the search screen and
// the admin editor so defaults stay in one place.

import type { CityTaxConfig, FeeRule, TaxRule } from "./pricing";
import type { GoogleAdsLinkRecord } from "./google-ari/account-link";

export interface Highlight {
  title: string;
  description: string;
}

export interface SearchContent {
  eyebrow?: string; // defaults to the property name
  heading?: string;
  intro?: string;
  promoText?: string;
  /** Placeholder shown inside the promo-code input (an example code). */
  promoPlaceholder?: string;
  searchButton?: string;
  highlights?: Highlight[];
  heroImage?: string; // language-independent; falls back to the Channex photo
}

/** Default promo-code input placeholder. Not in DEFAULT_SEARCH/translations
 *  because it's an example code, not translated copy. */
export const DEFAULT_PROMO_PLACEHOLDER = "SUMMER10";

/**
 * A legal link the hotel adds themselves: a German Impressum, house rules, a
 * cookie policy — the ones we can't name in advance.
 *
 * `label` is shown VERBATIM in every language. We can't translate what we don't
 * ship, and a hotel that types "Impressum" wants that word in front of every
 * guest, not "Imprint" for the English ones.
 *
 * `accept` is the difference between a link and an obligation: house rules the
 * guest must tick before booking, versus an Impressum that only has to be
 * reachable. Both still sit in the footer when they have a URL — an acceptance
 * a guest can't re-read on another page would be a worse consent record, not a
 * better one.
 */
/**
 * How a property's non-essential tags are gated.
 *
 *  banner    our own banner asks, and nothing fires until the guest says yes.
 *  external  the hotel's own CMP (Cookiebot, OneTrust, Osano) grants — we emit
 *            Consent Mode defaults of denied and show no banner of our own.
 *  off       tags fire immediately. Legal outside the EU/EEA; inside it, the
 *            hotel is choosing to carry that risk, and the admin copy says so.
 *
 * The default is `banner`, deliberately: the posture that is safe everywhere is
 * the one a hotel gets by not reading the setting.
 */
export type ConsentPosture = "banner" | "external" | "off";

export interface AnalyticsSettings {
  /** GA4 Measurement IDs (`G-…`). Plural because hotel-plus-agency dual tagging
   *  is the normal case, not an edge case. */
  ga4MeasurementIds?: string[];
  /** Google Tag Manager container (`GTM-…`). */
  gtmContainerId?: string;
  /** Google Ads conversion (`AW-…` plus the conversion's label). Both or
   *  neither — a send_to needs the pair, and half of one silently measures
   *  nothing. */
  adsConversionId?: string;
  adsConversionLabel?: string;
  consent?: ConsentPosture;
}

export interface LegalLink {
  label: string;
  url?: string;
  accept?: boolean;
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
      {
        key: "requestsPlaceholder",
        label: "Special requests placeholder",
        default: "Quiet room, early check-in, anything we should know…",
      },
      { key: "paymentSection", label: "Payment section title", default: "Payment" },
      {
        key: "paymentNote",
        label: "Payment note",
        textarea: true,
        default:
          "Your flexible rate is paid at the hotel. We only need a card to guarantee the booking — you won't be charged today.",
      },
      { key: "completeButton", label: "Complete button", default: "Complete booking" },
    ],
  },
  {
    id: "extras",
    label: "Extras",
    fields: [
      { key: "heading", label: "Room section heading ({room} = room name)", default: "Enhance your {room}" },
      { key: "intro", label: "Intro line", textarea: true, default: "Optional add-ons to make your stay special." },
      { key: "stayTitle", label: "Stay-wide section title", default: "For your whole stay" },
      { key: "summaryLabel", label: "Summary “Extras” label", default: "Extras" },
      { key: "continueButton", label: "Continue button", default: "Continue" },
      { key: "skipButton", label: "Skip button", default: "Skip for now" },
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

/** Merge stored overrides over the page's (language-aware) defaults. */
export function withDefaults(
  id: string,
  overrides: Record<string, string | undefined> = {},
  lang: string = DEFAULT_LANG,
): Record<string, string> {
  const defaults = pageDefaults(id, lang);
  const out: Record<string, string> = {};
  for (const key of Object.keys(defaults)) out[key] = overrides[key]?.trim() || defaults[key];
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

// Curated Google-Font pairings the AI branding flow can choose from — a bounded
// allowlist so we control exactly which stylesheets load (no arbitrary font
// injection). `heading` maps to --font-serif, `body` to --font-sans. `href` is a
// Google Fonts CSS URL; `default` reuses the fonts already loaded in root.tsx.
/**
 * Where the default pair's faces were mirrored FROM. Nothing loads this at
 * runtime any more — scripts/fetch-fonts.mjs reads it, downloads the files into
 * public/fonts/ and generates the @font-face rules we serve ourselves, because
 * a guest's browser must never be made to contact Google (see the script).
 *
 * FONT_PAIRS[0] carries no href of its own, so this is the entry the script
 * uses for the default pair. Keep the axes in step with the other pairs: root
 * was once trimmed to drop `opsz` while the brand kit kept serving the heavy
 * two-axis version.
 */
export const DEFAULT_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500;600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap";

export const FONT_PAIRS = [
  { id: "default", label: "Newsreader + Hanken Grotesk (default)", heading: '"Newsreader", ui-serif, Georgia, serif', body: '"Hanken Grotesk", system-ui, sans-serif', href: "" },
  { id: "playfair-inter", label: "Playfair Display + Inter", heading: '"Playfair Display", ui-serif, Georgia, serif', body: '"Inter", system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@500;600;700&display=swap" },
  { id: "cormorant-montserrat", label: "Cormorant Garamond + Montserrat", heading: '"Cormorant Garamond", ui-serif, Georgia, serif', body: '"Montserrat", system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Montserrat:wght@400;500;600;700&display=swap" },
  { id: "fraunces-nunito", label: "Fraunces + Nunito Sans", heading: '"Fraunces", ui-serif, Georgia, serif', body: '"Nunito Sans", system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Nunito+Sans:wght@400;600;700&display=swap" },
  { id: "lora-worksans", label: "Lora + Work Sans", heading: '"Lora", ui-serif, Georgia, serif', body: '"Work Sans", system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Work+Sans:wght@400;500;600;700&display=swap" },
  { id: "dmserif-dmsans", label: "DM Serif Display + DM Sans", heading: '"DM Serif Display", ui-serif, Georgia, serif', body: '"DM Sans", system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap" },
  { id: "poppins", label: "Poppins (modern sans)", heading: '"Poppins", system-ui, sans-serif', body: '"Poppins", system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" },
  { id: "spacegrotesk-inter", label: "Space Grotesk + Inter", heading: '"Space Grotesk", ui-sans-serif, system-ui', body: '"Inter", system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" },
] as const;

export type FontPairId = (typeof FONT_PAIRS)[number]["id"];
/** The pair used when a property hasn't chosen one — FONT_PAIRS[0]. Named
 *  because the font-face components branch on it. */
export const DEFAULT_FONT_PAIR_ID: FontPairId = FONT_PAIRS[0].id;
export function fontPair(id: string | undefined) {
  return FONT_PAIRS.find((f) => f.id === id) ?? FONT_PAIRS[0];
}
export function isFontPairId(value: string): value is FontPairId {
  return FONT_PAIRS.some((f) => f.id === value);
}

export type DeadlineUnit = "hours" | "days";

// Google Vacation Rentals amenities — Google accepts a fixed vocabulary of
// <client_attr> amenity names, not free text. These power the property amenities
// picker and the VR list feed. Boolean amenities are sent as "Yes" when enabled;
// the enum amenities take one of their listed values.
// https://developers.google.com/hotels/vacation-rentals/dev-guide/vr-attributes
export const VR_AMENITIES: { key: string; label: string }[] = [
  { key: "wifi", label: "Wi-Fi" },
  { key: "ac", label: "Air conditioning" },
  { key: "heating", label: "Heating" },
  { key: "kitchen", label: "Kitchen" },
  { key: "washer_dryer", label: "Washer / dryer" },
  { key: "tv", label: "TV" },
  { key: "microwave", label: "Microwave" },
  { key: "oven_stove", label: "Oven / stove" },
  { key: "balcony", label: "Balcony" },
  { key: "patio", label: "Patio" },
  { key: "elevator", label: "Elevator" },
  { key: "gym_fitness_equipment", label: "Gym / fitness equipment" },
  { key: "hot_tub", label: "Hot tub" },
  { key: "fire_place", label: "Fireplace" },
  { key: "crib", label: "Crib" },
  { key: "child_friendly", label: "Child friendly" },
  { key: "pets_allowed", label: "Pets allowed" },
  { key: "smoking_free_property", label: "Smoke-free property" },
  { key: "wheelchair_accessible", label: "Wheelchair accessible" },
  { key: "beach_access", label: "Beach access" },
  { key: "airport_shuttle", label: "Airport shuttle" },
  { key: "free_breakfast", label: "Free breakfast" },
  { key: "ironing_board", label: "Ironing board" },
  { key: "outdoor_grill", label: "Outdoor grill / BBQ" },
];

/** VR amenities that take one of a set of values rather than a yes/no. */
export const VR_AMENITY_ENUMS: { key: string; label: string; options: string[] }[] = [
  { key: "parking_type", label: "Parking", options: ["Free", "Paid", "None"] },
  { key: "pool_type", label: "Pool", options: ["Indoors", "Outdoors", "Indoors/Outdoors", "None"] },
  { key: "internet_type", label: "Internet", options: ["Free", "Paid", "None"] },
];

export const VR_AMENITY_KEYS = new Set(VR_AMENITIES.map((a) => a.key));

// ---- Property facilities (guest-facing display) ----
//
// Deliberately SEPARATE from VR_AMENITIES above. That list is Google's
// controlled vocabulary for the Vacation Rentals feed — a feed contract, only
// valid for single-unit properties, and changing it changes what we send
// Google. This list is display copy for the guest pages and a website, and
// applies to every property. Keeping them apart means neither can be broken by
// an edit meant for the other; the admin offers a one-way copy for the overlap.
//
// Curated (not free text) because each key is a translated label in every guest
// language. Anything not covered here goes in the per-language free-text lines.
export const PROPERTY_FACILITIES = [
  "wifi",
  "parking",
  "freeParking",
  "evCharging",
  "pool",
  "spa",
  "sauna",
  "hotTub",
  "gym",
  "restaurant",
  "bar",
  "breakfast",
  "roomService",
  "airConditioning",
  "reception24h",
  "luggageStorage",
  "laundry",
  "meetingRooms",
  "garden",
  "terrace",
  "beachAccess",
  "airportShuttle",
  "familyFriendly",
  "petFriendly",
  "accessible",
  "nonSmoking",
] as const;

export type PropertyFacility = (typeof PROPERTY_FACILITIES)[number];

const FACILITY_KEYS = new Set<string>(PROPERTY_FACILITIES);

/** Keep only known keys, in catalogue order — so a stale form can't inject a
 *  key with no translated label (which would render as the raw key). */
export function normalizeFacilities(input: string[]): PropertyFacility[] {
  const chosen = new Set(input.filter((k) => FACILITY_KEYS.has(k)));
  return PROPERTY_FACILITIES.filter((k) => chosen.has(k));
}

/** The i18n key for a facility label, in both the guest and admin dictionaries. */
export const facilityLabelKey = (key: string) => `fac_${key}`;

/** Property-wide pricing mode — see SiteSettings.pricingMode. */
export type PricingMode = "per_room" | "per_person";

export interface SiteSettings {
  theme?: ThemeId | "custom";
  customColor?: string;
  customBg?: string;
  /** Curated Google-Font pairing id (see FONT_PAIRS). Unset = default fonts. */
  themeFont?: string;
  /** The property's own stylesheet, rendered inside the guest wrapper (booking
   *  pages, website, voucher and manage pages, the embed widget). Sanitised on
   *  save AND render by app/lib/custom-css.ts; the vocabulary of tokens and
   *  `ui-*` hook classes is in docs/custom-css.md. Never on admin pages. */
  customCss?: string;
  /** Property cover photo (/images/… path). Used as the property's image on the
   *  Collections cards; falls back to the cheapest room's photo when unset. */
  coverImage?: string;
  /** Property logo (/images/… path). Shown in the guest booking header in place
   *  of the diamond mark; the hotel name stays beside it unless `logoHideName`
   *  is set (for logos that already read as a wordmark). */
  logoImage?: string;
  /** Hide the text hotel name in the header when a logo is set — for logos that
   *  already contain the name. Ignored when there's no logo. */
  logoHideName?: boolean;
  /** Browser-tab icon for this hotel's GUEST pages (/images/… path). Wins over a
   *  white-label partner's favicon on a property page, since the tab belongs to
   *  the hotel; unset falls back to the partner's, then to ours. Admin pages are
   *  unaffected — that chrome is never the hotel's.
   *
   *  Registered in image-gc.server so the GC counts it as referenced. */
  faviconImage?: string;
  // ----- Website -----
  /** Opt in to the website layer. Off (default) = `/:channelId` is the booking
   *  search page exactly as before; on = it renders the website home page and
   *  the search box becomes a section of it. Turning it off restores the old
   *  page — nothing is destroyed either way. */
  websiteEnabled?: boolean;
  /** The hotel's own hostname, e.g. "www.spilmanhotel.co.uk". Stored once they
   *  enter it; pointing DNS and activating the hostname are separate steps, so
   *  a value here does NOT mean the domain is serving. */
  websiteDomain?: string;
  /** Guest-facing property facilities — keys from PROPERTY_FACILITIES. Free-text
   *  extras live per language in the content store (they need translating). */
  facilities?: string[];
  // ----- Analytics & advertising -----
  /** Measurement tags and the consent posture that governs them. Absent means
   *  the property is untagged: nothing third-party loads, and no consent banner
   *  is shown because there is nothing to consent to. */
  analytics?: AnalyticsSettings;
  /** Links shown in the checkout consent line (rendered as links only when set). */
  termsUrl?: string;
  privacyUrl?: string;
  /** The hotel's own legal links, beyond the two above. */
  legalLinks?: LegalLink[];
  /** ISO currency code for all prices (e.g. GBP). Defaults to GBP when unset. */
  currency?: string;
  /** How every rate prices: flat per room (default) or per person (per adult).
   *  Property-wide, not per rate — Channex applies sell mode to the whole
   *  channel connection, so a per-rate mix would advertise a mapping it can't
   *  fulfil. Unset = derived from legacy per-rate flags (see pricingModeOf). */
  pricingMode?: PricingMode;
  languages?: string[]; // enabled languages (always includes the base language)
  /** The language guests are served when nothing else decides it — no `?lang`,
   *  no cookie, and no Accept-Language match among the enabled languages. One
   *  of the enabled languages; unset = English. Distinct from the BASE language
   *  (DEFAULT_LANG), which is where a hotel's copy is written and what every
   *  untranslated field falls back to — that stays English regardless. */
  defaultLanguage?: string;
  /** When true, checkout pushes real bookings to Channex; when false it simulates.
   *  Unset (never saved) falls back to the ALLOW_LIVE_BOOKING env var. */
  liveBooking?: boolean;
  /** Single-unit mode: the property is one bookable unit (an apartment/studio),
   *  so the guest books it straight from its detail page — the room-selection
   *  list is skipped and results renders as a booking review. */
  singleUnit?: boolean;
  // ----- Taxes & fees -----
  /** true = inventory prices already include the taxes; false/undefined = add on top. */
  taxesInclusive?: boolean;
  taxes?: TaxRule[];
  fees?: FeeRule[];
  cityTax?: CityTaxConfig;
  // ----- Customer Portal (manage-my-booking) -----
  allowCancel?: boolean;
  allowModify?: boolean;
  /** Auto-refund the Stripe charge when a guest cancels within the free window.
   *  Off (default) = the hotel issues any refund manually. */
  autoRefund?: boolean;
  /** Voucher cooling-off: days after purchase in which the BUYER can self-cancel
   *  for a full (auto-refunded) refund. Unset = 14; 0 disables self-cancel. */
  voucherCoolingOffDays?: number;
  /** Default windows used when a rate plan doesn't set its own. */
  cancelDeadlineValue?: number;
  cancelDeadlineUnit?: DeadlineUnit;
  /**
   * "HH:MM" local time on the ARRIVAL DATE that cancellation deadlines count
   * back from. Default 18:00 (see DEFAULT_CANCEL_ANCHOR).
   *
   * This is what makes "24 hours before arrival" mean 6pm the night before rather
   * than midnight, and what lets a deadline of 0 mean "6pm on the day you
   * arrive" — the flexible-city-hotel policy. Evaluated in `timezone`.
   */
  cancelAnchorTime?: string;
  modifyDeadlineValue?: number;
  modifyDeadlineUnit?: DeadlineUnit;
  /** Shown to guests once the cancel/modify deadline has passed. */
  afterDeadlineMessage?: string;
  // ----- Booking lead time (last-minute cutoff) -----
  /** IANA timezone used to evaluate the same-day cutoff. Defaults to UTC. */
  timezone?: string;
  /** Minimum lead time before check-in. undefined = no limit; 0 = same-day
   *  bookings allowed until `bookingCutoffTime`; 1-7 = require N days ahead. */
  bookingCutoffDays?: number;
  /** "HH:MM" local time after which same-day check-ins stop (when days === 0). */
  bookingCutoffTime?: string;
  /** Open the search page's date picker with the earliest bookable stay (first
   *  available check-in + its shortest valid stay) already selected. Pre-fills
   *  the fields only — no search runs until the guest asks for one. */
  preselectFirstAvailable?: boolean;
  // ----- Check-in / check-out times -----
  /** "HH:MM" local check-in-from and check-out-by times. Shown to guests and
   *  emitted in Google structured data; default 15:00 / 11:00 when unset. */
  checkinTime?: string;
  checkoutTime?: string;
  /** Guest reviews on/off for this property. Unset = ON (the long-standing
   *  behaviour). OFF: no review-request emails go out, the website's reviews
   *  section is not rendered, and the guest review link answers Not found.
   *  Existing reviews are kept and stay visible in the admin. See reviewsOn(). */
  reviewsEnabled?: boolean;
  /** "HH:MM" LATEST check-in (end of the reception window). When set, the
   *  checkout page offers arrival times only between checkinTime and this, so
   *  a guest can't self-select an hour nobody is at the desk (see
   *  arrival-times.ts). Unset = every half hour, the long-standing behaviour.
   *  Display-only otherwise: not in structured data, not sent to Channex. */
  checkinUntil?: string;
  // ----- Structured location (Google Hotel List Feed + structured data) -----
  /** Street line falls back to the localized PropertyOverrides.address. These
   *  structured parts + geo power the Google Hotel List Feed matching. */
  addressCity?: string;
  addressRegion?: string;
  addressPostalCode?: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "GB". */
  addressCountry?: string;
  /** Decimal degrees, stored as strings. */
  latitude?: string;
  longitude?: string;
  // ----- Connectivity -----
  /** The channel-manager / PMS system this property is connected to (e.g. "channex"). */
  connectedSystem?: string;
  // ----- Transactional email -----
  /** Sender display name for guest/host emails (the from-domain is global). */
  emailFromName?: string;
  /** Reply-to address guests' replies go to (defaults to the contact email). */
  emailReplyTo?: string;
  /** Where host notifications are sent (defaults to the property contact email). */
  hostNotifyEmail?: string;
  /** Notify the host when a booking is made / cancelled. Default on. */
  notifyHostOnBooking?: boolean;
  notifyHostOnCancel?: boolean;
  // ----- Payments (Stripe Connect, per-property) -----
  /** Connected Stripe account id (acct_…) charges run on. Unset = not connected. */
  stripeAccountId?: string;
  /** Cached from the connected account: whether it can accept charges. */
  stripeChargesEnabled?: boolean;
  // ----- Google Hotels ARI push (direct rooms/rates/discounts/availability) -----
  /** Which Google program this property pushes to. "hotels" (default) uses the
   *  Hotel Center partner account; "vacation_rentals" uses the VR partner account
   *  and pushes VR-shaped messages (single unit, binary inventory) + is fed via
   *  the VR list feed. VR is only valid for single-unit properties. */
  googleProgram?: "hotels" | "vacation_rentals";
  /** Google Vacation Rentals amenities (from VR_AMENITIES) the property offers —
   *  a curated allowlist so the feed sends Google's controlled vocabulary, not
   *  free-text. Boolean amenities present here are sent as "Yes". */
  vrAmenities?: string[];
  /** Google VR enum amenities (from VR_AMENITY_ENUMS), keyed by attr name, e.g.
   *  { parking_type: "Free", pool_type: "Outdoors" }. Empty/absent = omitted. */
  vrAmenityOptions?: Record<string, string>;
  /** Google VR unit size, sent as client_attr number_of_* — Google REQUIRES these
   *  before a VR listing can go live. undefined = not set (0 bedrooms is valid —
   *  a studio); bathrooms may be a half (e.g. 1.5). */
  vrBedrooms?: number;
  vrBathrooms?: number;
  vrBeds?: number;
  /** Master switch: push this property's ARI (property data, rates, availability,
   *  inventory, taxes, promotions) directly to Google. Off (default) = no push. */
  googleAriPush?: boolean;
  /** How many days ahead of today to push availability/rates for. Default 365.
   *  (The last-sync status lives in its own KV key — see GoogleAriSyncStatus in
   *  overrides.server — so automated status writes can't clobber settings.) */
  googleAriWindowDays?: number;
  /** The hotel's own Google Ads account, linked to OUR Hotel Center account and
   *  scoped to this property's hotel id, so it can run paid Hotel campaigns that
   *  land on these booking pages. Absent = not linked. See
   *  google-ari/account-link.server.ts + docs/google-ads-link.md. */
  googleAdsLink?: GoogleAdsLinkRecord;
}

/** Lead-time cutoff in the shape the client-safe date helpers consume. */
export interface BookingCutoff {
  days?: number;
  time?: string;
  timezone?: string;
}

export function bookingCutoffOf(s: SiteSettings): BookingCutoff {
  return { days: s.bookingCutoffDays, time: s.bookingCutoffTime, timezone: s.timezone };
}

export const isDeadlineUnit = (v: string): v is DeadlineUnit => v === "hours" || v === "days";

// Supported content languages for the booking pages. `label` is the endonym
// (the language's name in itself); `flag` is a representative country flag emoji
// (a pragmatic convention — a language isn't a country, but it reads instantly).
export const LANGUAGES = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "de", label: "Deutsch", flag: "🇩🇪" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "it", label: "Italiano", flag: "🇮🇹" },
  { code: "pt", label: "Português", flag: "🇵🇹" },
  { code: "nl", label: "Nederlands", flag: "🇳🇱" },
  { code: "el", label: "Ελληνικά", flag: "🇬🇷" },
  { code: "th", label: "ไทย", flag: "🇹🇭" },
  { code: "tr", label: "Türkçe", flag: "🇹🇷" },
] as const;

/**
 * The BASE language: where a hotel's copy is written, the admin editor's first
 * tab, and the per-field fallback for anything untranslated. This is not the
 * language guests are served by default — that is `settings.defaultLanguage`
 * (see `guestDefaultLang`), which a hotel picks from its enabled languages.
 * Until 2026-09-09 the two were the same constant, so a German hotel with
 * German guests greeted every one of them in English.
 */
export const DEFAULT_LANG = "en";

export function isLang(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code);
}

/** Validate a language code, falling back to the base language. */
export function pickLang(code: string): string {
  return isLang(code) ? code : DEFAULT_LANG;
}

export const LANG_COOKIE = "ibe_lang";

/** The guest-facing default: the hotel's choice if it is enabled, else English. */
export function guestDefaultLang(settings: Pick<SiteSettings, "languages" | "defaultLanguage">): string {
  const want = settings.defaultLanguage ?? "";
  return isLang(want) && enabledLanguages(settings).includes(want) ? want : DEFAULT_LANG;
}

/**
 * Best match for an Accept-Language header among `candidates` (enabled
 * languages, in the hotel's order). Honours q-weights; `de-AT` matches `de`.
 * Undefined when nothing the browser lists is on offer — the caller's default
 * takes over, never a guess.
 */
export function negotiateLang(accept: string | null | undefined, candidates: readonly string[]): string | undefined {
  if (!accept) return undefined;
  const ranked = accept
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((x) => x.trim()).find((x) => x.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { lang: tag.trim().toLowerCase().split("-")[0], weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.lang && x.lang !== "*" && x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  return ranked.find((x) => candidates.includes(x.lang))?.lang;
}

/**
 * Guest language: `?lang` wins, then the sticky `ibe_lang` cookie, then the
 * browser's Accept-Language matched against the hotel's enabled languages, then
 * the hotel's default language.
 *
 * With `settings`, only the hotel's ENABLED languages are honoured — a `?lang=es`
 * link to a hotel that never enabled Spanish used to serve Spanish UI labels
 * over English copy. Without settings (a page that belongs to no property)
 * every supported language is a candidate and the default is English.
 */
export function langFromRequest(
  request: Request,
  settings?: Pick<SiteSettings, "languages" | "defaultLanguage">,
): string {
  const candidates = settings ? enabledLanguages(settings) : LANGUAGES.map((l) => l.code);
  const ok = (code: string | null | undefined): code is string => !!code && candidates.includes(code);
  const param = new URL(request.url).searchParams.get("lang");
  if (ok(param)) return param;
  const cookie = request.headers.get("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)ibe_lang=([^;]+)/);
  if (m && ok(m[1])) return m[1];
  const negotiated = negotiateLang(request.headers.get("Accept-Language"), candidates);
  if (negotiated) return negotiated;
  return settings ? guestDefaultLang(settings) : DEFAULT_LANG;
}

/** Admin language: `?lang` only (independent of the guest cookie). */
export function langParam(request: Request): string {
  return pickLang(new URL(request.url).searchParams.get("lang") ?? "");
}

export function langLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

export function langFlag(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.flag ?? "🌐";
}

/** Enabled languages from settings — always includes the base language and the
 *  hotel's default language, only valid codes, in LANGUAGES order. */
export function enabledLanguages(settings: Pick<SiteSettings, "languages" | "defaultLanguage">): string[] {
  const set = new Set([DEFAULT_LANG, ...(settings.languages ?? []), settings.defaultLanguage ?? ""].filter(isLang));
  return LANGUAGES.map((l) => l.code).filter((c) => set.has(c));
}

/** Returns a normalized #rrggbb / #rgb hex, or undefined if invalid. */
export function normalizeHex(value: string): string | undefined {
  const s = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s.toLowerCase() : undefined;
}

// Defaults are deliberately free of promises. Until 2026-09-08 a property that
// had not written its own copy showed "Free cancellation up to 24h before
// arrival" and "Best rate, guaranteed" to every guest — claims the hotel never
// made, and for one customer the opposite of its real terms (7 days free, then
// 50%). A blank highlights list hides the section; the hotel writes its own.
export const DEFAULT_SEARCH = {
  heading: "Reserve your stay",
  intro: "Check live availability and book your stay directly with us.",
  promoText: "Add a promo or corporate code",
  searchButton: "Search rooms",
  highlights: [] as Highlight[],
};

// ---- Translations of the built-in defaults ----
// English lives in DEFAULT_SEARCH / EDITABLE_PAGES; only non-English here.
// Machine-quality baseline — each hotel can refine it in the admin.
type SearchDefaults = typeof DEFAULT_SEARCH;

const SEARCH_TRANSLATIONS: Record<string, SearchDefaults> = {
  fr: {
    heading: "Réservez votre séjour",
    intro: "Consultez les disponibilités en temps réel et réservez votre séjour directement auprès de nous.",
    promoText: "Ajouter un code promo ou entreprise",
    searchButton: "Rechercher",
    highlights: [],
  },
  de: {
    heading: "Reservieren Sie Ihren Aufenthalt",
    intro: "Prüfen Sie die aktuelle Verfügbarkeit und buchen Sie Ihren Aufenthalt direkt bei uns.",
    promoText: "Promo- oder Firmencode hinzufügen",
    searchButton: "Zimmer suchen",
    highlights: [],
  },
  es: {
    heading: "Reserve su estancia",
    intro: "Consulte la disponibilidad en tiempo real y reserve su estancia directamente con nosotros.",
    promoText: "Añadir un código promocional o corporativo",
    searchButton: "Buscar habitaciones",
    highlights: [],
  },
  it: {
    heading: "Prenota il tuo soggiorno",
    intro: "Verifica la disponibilità in tempo reale e prenota il tuo soggiorno direttamente con noi.",
    promoText: "Aggiungi un codice promozionale o aziendale",
    searchButton: "Cerca camere",
    highlights: [],
  },
  pt: {
    heading: "Reserve a sua estadia",
    intro: "Consulte a disponibilidade em tempo real e reserve a sua estadia diretamente connosco.",
    promoText: "Adicionar um código promocional ou empresarial",
    searchButton: "Procurar quartos",
    highlights: [],
  },
  nl: {
    heading: "Reserveer uw verblijf",
    intro: "Bekijk de actuele beschikbaarheid en boek uw verblijf rechtstreeks bij ons.",
    promoText: "Voeg een promo- of bedrijfscode toe",
    searchButton: "Zoek kamers",
    highlights: [],
  },
  el: {
    heading: "Κλείστε τη διαμονή σας",
    intro: "Δείτε τη διαθεσιμότητα σε πραγματικό χρόνο και κλείστε τη διαμονή σας απευθείας σε εμάς.",
    promoText: "Προσθέστε κωδικό προσφοράς ή εταιρικό κωδικό",
    searchButton: "Αναζήτηση δωματίων",
    highlights: [],
  },
  th: {
    heading: "จองการเข้าพักของคุณ",
    intro: "เช็คห้องว่างแบบเรียลไทม์และจองการเข้าพักของคุณกับเราโดยตรง",
    promoText: "ใส่รหัสส่วนลดหรือรหัสองค์กร",
    searchButton: "ค้นหาห้องพัก",
    highlights: [],
  },
  tr: {
    heading: "Konaklamanızı ayırtın",
    intro: "Güncel müsaitlik durumunu görün ve konaklamanızı doğrudan bizden ayırtın.",
    promoText: "Promosyon veya kurumsal kod ekleyin",
    searchButton: "Oda ara",
    highlights: [],
  },
};

export function searchDefaults(lang: string): SearchDefaults {
  return SEARCH_TRANSLATIONS[lang] ?? DEFAULT_SEARCH;
}

const PAGE_TRANSLATIONS: Record<string, Record<string, Record<string, string>>> = {
  results: {
    fr: { heading: "Choisissez vos chambres", editSearch: "Modifier la recherche", cartTitle: "Votre séjour", continueButton: "Continuer vers les détails" },
    de: { heading: "Wählen Sie Ihre Zimmer", editSearch: "Suche ändern", cartTitle: "Ihr Aufenthalt", continueButton: "Weiter zu den Angaben" },
    es: { heading: "Elija sus habitaciones", editSearch: "Editar búsqueda", cartTitle: "Su estancia", continueButton: "Continuar a los datos" },
    it: { heading: "Scegli le tue camere", editSearch: "Modifica ricerca", cartTitle: "Il tuo soggiorno", continueButton: "Continua ai dettagli" },
    pt: { heading: "Escolha os seus quartos", editSearch: "Editar pesquisa", cartTitle: "A sua estadia", continueButton: "Continuar para os detalhes" },
    nl: { heading: "Kies uw kamers", editSearch: "Zoekopdracht wijzigen", cartTitle: "Uw verblijf", continueButton: "Doorgaan naar gegevens" },
    el: { heading: "Επιλέξτε τα δωμάτιά σας", editSearch: "Αλλαγή αναζήτησης", cartTitle: "Η διαμονή σας", continueButton: "Συνέχεια στα στοιχεία" },
    th: { heading: "เลือกห้องพักของคุณ", editSearch: "แก้ไขการค้นหา", cartTitle: "การเข้าพักของคุณ", continueButton: "ไปกรอกข้อมูล" },
    tr: { heading: "Odalarınızı seçin", editSearch: "Aramayı düzenle", cartTitle: "Konaklamanız", continueButton: "Bilgilere devam et" },
  },
  detail: {
    fr: { backLink: "Toutes les chambres", amenitiesTitle: "Dans cette chambre", rateTitle: "Choisissez votre tarif", addButton: "Ajouter à votre séjour" },
    de: { backLink: "Alle Zimmer", amenitiesTitle: "In diesem Zimmer", rateTitle: "Wählen Sie Ihren Tarif", addButton: "Zum Aufenthalt hinzufügen" },
    es: { backLink: "Todas las habitaciones", amenitiesTitle: "En esta habitación", rateTitle: "Elija su tarifa", addButton: "Añadir a su estancia" },
    it: { backLink: "Tutte le camere", amenitiesTitle: "In questa camera", rateTitle: "Scegli la tua tariffa", addButton: "Aggiungi al soggiorno" },
    pt: { backLink: "Todos os quartos", amenitiesTitle: "Neste quarto", rateTitle: "Escolha a sua tarifa", addButton: "Adicionar à estadia" },
    nl: { backLink: "Alle kamers", amenitiesTitle: "In deze kamer", rateTitle: "Kies uw tarief", addButton: "Toevoegen aan verblijf" },
    el: { backLink: "Όλα τα δωμάτια", amenitiesTitle: "Σε αυτό το δωμάτιο", rateTitle: "Επιλέξτε τιμή", addButton: "Προσθήκη στη διαμονή" },
    th: { backLink: "ห้องพักทั้งหมด", amenitiesTitle: "ในห้องนี้", rateTitle: "เลือกแพ็กเกจราคาของคุณ", addButton: "เพิ่มในการเข้าพักของคุณ" },
    tr: { backLink: "Tüm odalar", amenitiesTitle: "Bu odada", rateTitle: "Fiyat planınızı seçin", addButton: "Konaklamanıza ekle" },
  },
  checkout: {
    fr: { heading: "Vos coordonnées", guestSection: "Informations du client", arrivalSection: "Arrivée et demandes", requestsPlaceholder: "Chambre calme, arrivée tôt, tout ce que nous devrions savoir…", paymentSection: "Paiement", paymentNote: "Votre tarif flexible est payé à l'hôtel. Nous avons seulement besoin d'une carte pour garantir la réservation — vous ne serez pas débité aujourd'hui.", completeButton: "Finaliser la réservation" },
    de: { heading: "Ihre Angaben", guestSection: "Gästeinformationen", arrivalSection: "Anreise & Wünsche", requestsPlaceholder: "Ruhiges Zimmer, frühe Anreise, alles, was wir wissen sollten…", paymentSection: "Zahlung", paymentNote: "Ihr flexibler Tarif wird im Hotel bezahlt. Wir benötigen nur eine Karte zur Garantie der Buchung – heute wird nichts abgebucht.", completeButton: "Buchung abschließen" },
    es: { heading: "Sus datos", guestSection: "Información del huésped", arrivalSection: "Llegada y solicitudes", requestsPlaceholder: "Habitación tranquila, entrada temprana, cualquier cosa que debamos saber…", paymentSection: "Pago", paymentNote: "Su tarifa flexible se paga en el hotel. Solo necesitamos una tarjeta para garantizar la reserva: hoy no se le cobrará nada.", completeButton: "Completar la reserva" },
    it: { heading: "I tuoi dati", guestSection: "Informazioni dell'ospite", arrivalSection: "Arrivo e richieste", requestsPlaceholder: "Camera silenziosa, arrivo anticipato, qualsiasi cosa dovremmo sapere…", paymentSection: "Pagamento", paymentNote: "La tua tariffa flessibile si paga in hotel. Ci serve solo una carta per garantire la prenotazione — oggi non verrà addebitato nulla.", completeButton: "Completa la prenotazione" },
    pt: { heading: "Os seus dados", guestSection: "Informações do hóspede", arrivalSection: "Chegada e pedidos", requestsPlaceholder: "Quarto tranquilo, entrada antecipada, tudo o que devamos saber…", paymentSection: "Pagamento", paymentNote: "A sua tarifa flexível é paga no hotel. Só precisamos de um cartão para garantir a reserva — não será cobrado hoje.", completeButton: "Concluir reserva" },
    nl: { heading: "Uw gegevens", guestSection: "Gastinformatie", arrivalSection: "Aankomst & verzoeken", requestsPlaceholder: "Rustige kamer, vroeg inchecken, alles wat we moeten weten…", paymentSection: "Betaling", paymentNote: "Uw flexibele tarief wordt in het hotel betaald. We hebben alleen een kaart nodig om de boeking te garanderen — vandaag wordt er niets afgeschreven.", completeButton: "Boeking voltooien" },
    el: { heading: "Τα στοιχεία σας", guestSection: "Στοιχεία επισκέπτη", arrivalSection: "Άφιξη & αιτήματα", requestsPlaceholder: "Ήσυχο δωμάτιο, πρόωρη άφιξη, ό,τι πρέπει να γνωρίζουμε…", paymentSection: "Πληρωμή", paymentNote: "Η ευέλικτη τιμή σας πληρώνεται στο ξενοδοχείο. Χρειαζόμαστε μόνο μια κάρτα για την εξασφάλιση της κράτησης — δεν θα χρεωθείτε σήμερα.", completeButton: "Ολοκλήρωση κράτησης" },
    th: { heading: "ข้อมูลของคุณ", guestSection: "ข้อมูลผู้เข้าพัก", arrivalSection: "การเดินทางถึงและคำขอเพิ่มเติม", requestsPlaceholder: "ห้องเงียบ เช็คอินก่อนเวลา หรือสิ่งอื่นที่เราควรทราบ…", paymentSection: "การชำระเงิน", paymentNote: "ราคาแบบยืดหยุ่นของคุณชำระที่โรงแรม เราขอเพียงบัตรเพื่อรับประกันการจอง — วันนี้ยังไม่มีการเรียกเก็บเงิน", completeButton: "ยืนยันการจอง" },
    tr: { heading: "Bilgileriniz", guestSection: "Misafir bilgileri", arrivalSection: "Varış ve istekler", requestsPlaceholder: "Sessiz oda, erken giriş, bilmemiz gereken her şey…", paymentSection: "Ödeme", paymentNote: "Esnek fiyat planınız otelde ödenir. Rezervasyonu garanti altına almak için yalnızca bir karta ihtiyacımız var — bugün tahsilat yapılmayacak.", completeButton: "Rezervasyonu tamamla" },
  },
  extras: {
    fr: { heading: "Améliorez votre {room}", intro: "Des extras facultatifs pour rendre votre séjour spécial.", stayTitle: "Pour tout votre séjour", summaryLabel: "Extras", continueButton: "Continuer", skipButton: "Passer pour l’instant" },
    de: { heading: "Verschönern Sie Ihr {room}", intro: "Optionale Extras für einen besonderen Aufenthalt.", stayTitle: "Für Ihren gesamten Aufenthalt", summaryLabel: "Extras", continueButton: "Weiter", skipButton: "Vorerst überspringen" },
    es: { heading: "Mejora tu {room}", intro: "Extras opcionales para hacer tu estancia especial.", stayTitle: "Para toda tu estancia", summaryLabel: "Extras", continueButton: "Continuar", skipButton: "Omitir por ahora" },
    it: { heading: "Arricchisci la tua {room}", intro: "Extra facoltativi per rendere speciale il tuo soggiorno.", stayTitle: "Per tutto il tuo soggiorno", summaryLabel: "Extra", continueButton: "Continua", skipButton: "Salta per ora" },
    pt: { heading: "Melhore o seu {room}", intro: "Extras opcionais para tornar a sua estadia especial.", stayTitle: "Para toda a sua estadia", summaryLabel: "Extras", continueButton: "Continuar", skipButton: "Ignorar por agora" },
    nl: { heading: "Maak je {room} compleet", intro: "Optionele extra’s om je verblijf bijzonder te maken.", stayTitle: "Voor je hele verblijf", summaryLabel: "Extra’s", continueButton: "Doorgaan", skipButton: "Nu overslaan" },
    el: { heading: "Αναβαθμίστε το {room}", intro: "Προαιρετικά έξτρα για να κάνετε τη διαμονή σας ξεχωριστή.", stayTitle: "Για όλη τη διαμονή σας", summaryLabel: "Έξτρα", continueButton: "Συνέχεια", skipButton: "Παράλειψη για τώρα" },
    th: { heading: "เพิ่มความพิเศษให้ {room}", intro: "บริการเสริมที่เลือกได้ เพื่อให้การเข้าพักของคุณพิเศษยิ่งขึ้น", stayTitle: "สำหรับการเข้าพักทั้งหมด", summaryLabel: "บริการเสริม", continueButton: "ดำเนินการต่อ", skipButton: "ข้ามไปก่อน" },
    tr: { heading: "{room} odanızı zenginleştirin", intro: "Konaklamanızı özel kılacak isteğe bağlı ek hizmetler.", stayTitle: "Tüm konaklamanız için", summaryLabel: "Ekstralar", continueButton: "Devam et", skipButton: "Şimdilik geç" },
  },
  confirmation: {
    fr: { heading: "Tout est confirmé", subtitle: "Votre séjour à {hotel} est confirmé. Un e-mail de confirmation est en route.", newBooking: "Faire une autre réservation" },
    de: { heading: "Alles erledigt", subtitle: "Ihr Aufenthalt im {hotel} ist bestätigt. Eine Bestätigungs-E-Mail ist unterwegs.", newBooking: "Weitere Buchung vornehmen" },
    es: { heading: "Todo listo", subtitle: "Su estancia en {hotel} está confirmada. Un correo de confirmación está en camino.", newBooking: "Hacer otra reserva" },
    it: { heading: "Tutto pronto", subtitle: "Il tuo soggiorno presso {hotel} è confermato. Un'e-mail di conferma è in arrivo.", newBooking: "Effettua un'altra prenotazione" },
    pt: { heading: "Está tudo pronto", subtitle: "A sua estadia no {hotel} está confirmada. Um e-mail de confirmação está a caminho.", newBooking: "Fazer outra reserva" },
    nl: { heading: "Helemaal geregeld", subtitle: "Uw verblijf in {hotel} is bevestigd. Een bevestigingsmail is onderweg.", newBooking: "Nog een boeking maken" },
    el: { heading: "Είστε έτοιμοι", subtitle: "Η διαμονή σας στο {hotel} επιβεβαιώθηκε. Ένα email επιβεβαίωσης βρίσκεται καθ’ οδόν.", newBooking: "Κάντε νέα κράτηση" },
    th: { heading: "เรียบร้อยแล้ว", subtitle: "การเข้าพักของคุณที่ {hotel} ได้รับการยืนยันแล้ว อีเมลยืนยันกำลังส่งถึงคุณ", newBooking: "จองอีกครั้ง" },
    tr: { heading: "Her şey hazır", subtitle: "{hotel} tesisindeki konaklamanız onaylandı. Onay e-postanız yolda.", newBooking: "Yeni bir rezervasyon yap" },
  },
};

/** Built-in page defaults for a language (English fields fill any gaps). */
export function pageDefaults(pageId: string, lang: string): Record<string, string> {
  const def = pageDef(pageId);
  const en: Record<string, string> = {};
  if (def) for (const f of def.fields) en[f.key] = f.default;
  if (lang === DEFAULT_LANG) return en;
  return { ...en, ...(PAGE_TRANSLATIONS[pageId]?.[lang] ?? {}) };
}

// ---- Editable transactional email templates ----
// Operators edit only plain prose (subject + heading + intro/outro) with
// {tokens}. The booking details block (rooms, dates, totals, due-now, manage
// link) is rendered by the system between intro and outro, so the copy can't
// break the layout or the numbers. Mirrors the page-text system above.
export interface TokenDef {
  /** The literal token, e.g. "{guest_first_name}". */
  token: string;
  desc: string;
}
export interface EmailDef {
  id: string;
  label: string;
  /** Who receives it — drives whether a manage link or guest-contact block shows. */
  recipient: "guest" | "host";
  fields: PageField[];
  tokens: TokenDef[];
}

const GUEST_TOKENS: TokenDef[] = [
  { token: "{hotel_name}", desc: "Your property's name" },
  { token: "{guest_first_name}", desc: "Guest's first name" },
  { token: "{guest_last_name}", desc: "Guest's last name" },
  { token: "{reference}", desc: "Booking reference code" },
  { token: "{checkin}", desc: "Check-in date" },
  { token: "{checkout}", desc: "Check-out date" },
  { token: "{nights}", desc: "Number of nights" },
  { token: "{total}", desc: "Grand total, with currency" },
  { token: "{due_now}", desc: "Amount due today" },
  { token: "{due_at_hotel}", desc: "Amount due at the hotel" },
  { token: "{manage_url}", desc: "Link the guest uses to manage the booking" },
];
const HOST_TOKENS: TokenDef[] = [
  ...GUEST_TOKENS.filter((t) => t.token !== "{manage_url}"),
  { token: "{guest_email}", desc: "Guest's email address" },
  { token: "{guest_phone}", desc: "Guest's phone number" },
];
// The couldn't-confirm email has no manage link, but adds the refunded amount.
const FAILED_TOKENS: TokenDef[] = [
  ...GUEST_TOKENS.filter((t) => t.token !== "{manage_url}"),
  { token: "{refund_amount}", desc: "Amount refunded to the guest, with currency" },
];
// The review request has no money/manage link — just stay context. The star
// rating buttons and the review link are rendered by the system, not typed.
const REVIEW_TOKENS: TokenDef[] = [
  { token: "{hotel_name}", desc: "Your property's name" },
  { token: "{guest_first_name}", desc: "Guest's first name" },
  { token: "{guest_last_name}", desc: "Guest's last name" },
  { token: "{checkin}", desc: "Check-in date" },
  { token: "{checkout}", desc: "Check-out date" },
  { token: "{nights}", desc: "Number of nights" },
];

const emailFields = (o: { subject: string; heading: string; intro: string; outro: string }): PageField[] => [
  { key: "subject", label: "Subject line", default: o.subject },
  { key: "heading", label: "Heading", default: o.heading },
  { key: "intro", label: "Intro — shown above the booking details", textarea: true, default: o.intro },
  { key: "outro", label: "Outro — shown below the booking details", textarea: true, default: o.outro },
];

export const EMAIL_TEMPLATES: EmailDef[] = [
  {
    id: "booking_confirmation",
    label: "Booking confirmation",
    recipient: "guest",
    tokens: GUEST_TOKENS,
    fields: emailFields({
      subject: "Your booking at {hotel_name} is confirmed ({reference})",
      heading: "You're booked, {guest_first_name}!",
      intro:
        "Thanks for booking direct with {hotel_name}. Here are the details of your stay — we can't wait to welcome you.",
      outro: "Need to make a change? Use the “Manage booking” button above any time. See you soon!",
    }),
  },
  {
    id: "host_notification",
    label: "New booking (to you)",
    recipient: "host",
    tokens: HOST_TOKENS,
    fields: emailFields({
      subject: "New booking: {guest_first_name} {guest_last_name} — {reference}",
      heading: "New booking received",
      intro:
        "A new booking just came in through your booking page. The guest's contact details and the full breakdown are below.",
      outro: "",
    }),
  },
  {
    id: "booking_cancellation",
    label: "Cancellation (to guest)",
    recipient: "guest",
    tokens: GUEST_TOKENS,
    fields: emailFields({
      subject: "Your booking at {hotel_name} has been cancelled ({reference})",
      heading: "Your booking is cancelled",
      intro:
        "We've cancelled your booking at {hotel_name}, {guest_first_name}. The details of the cancelled reservation are below.",
      outro: "If you didn't request this, please contact us right away.",
    }),
  },
  {
    id: "cancellation_notification",
    label: "Cancellation (to you)",
    recipient: "host",
    tokens: HOST_TOKENS,
    fields: emailFields({
      subject: "Cancelled: {guest_first_name} {guest_last_name} — {reference}",
      heading: "Booking cancelled",
      intro: "A guest has cancelled their booking. The cancelled reservation details are below.",
      outro: "",
    }),
  },
  {
    id: "booking_failed",
    label: "Couldn't confirm (to guest)",
    recipient: "guest",
    tokens: FAILED_TOKENS,
    fields: emailFields({
      subject: "We couldn't confirm your booking at {hotel_name} ({reference})",
      heading: "Sorry, {guest_first_name} — we couldn't confirm your booking",
      intro:
        "Unfortunately the room sold out before your payment completed, so we couldn't confirm your stay at {hotel_name}. We've refunded {refund_amount} in full to your card — it can take a few days to appear.",
      outro: "We're sorry for the disappointment. Please try different dates, and do reach out if we can help.",
    }),
  },
  {
    id: "review_request",
    // The only template that sends more than once (checkout day, then 3 and 5
    // days later — see review-requests.server). Same mail each time except the
    // subject: an unchanged one three times reads as a system stuck in a loop,
    // and the second and third land in a thread with the first. Everything
    // after `subject` is optional — blank falls back to the first.
    label: "Review request",
    recipient: "guest",
    tokens: REVIEW_TOKENS,
    fields: [
      { key: "subject", label: "Subject line", default: "How was your stay at {hotel_name}?" },
      {
        key: "subject2",
        label: "Subject line — 1st reminder (3 days after checkout)",
        default: "A minute to rate your stay, {guest_first_name}?",
      },
      {
        key: "subject3",
        label: "Subject line — 2nd reminder (5 days after checkout)",
        default: "Last chance to review your stay at {hotel_name}",
      },
      { key: "heading", label: "Heading", default: "How was your stay, {guest_first_name}?" },
      {
        key: "intro",
        label: "Intro — shown above the booking details",
        textarea: true,
        default:
          "Thanks for staying at {hotel_name}. We'd love to hear how it went — your feedback helps us improve and helps future guests choose.\n\nIt only takes a minute — just tap a star below to begin.",
      },
      { key: "outro", label: "Outro — shown below the booking details", textarea: true, default: "" },
    ],
  },
];

export function emailDef(id: string): EmailDef | undefined {
  return EMAIL_TEMPLATES.find((e) => e.id === id);
}

// The built-in non-English email copy lives in email-defaults.server.ts
// (server-only on purpose — this module is in the client bundle).
