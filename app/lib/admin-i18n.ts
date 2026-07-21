// Admin-UI translations. Separate from the guest i18n (app/lib/i18n.ts): the
// guest dictionary follows the property's enabled languages, while this one
// follows the signed-in admin's own preference — a cookie set from the header
// picker, defaulting to the browser's Accept-Language. English is the
// fallback for any missing key, so partially translated pages degrade
// gracefully rather than breaking.
import { useRouteLoaderData } from "react-router";

export type AdminLang = "en" | "de";
export const ADMIN_LANGS: { id: AdminLang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "de", label: "Deutsch" },
];
export const ADMIN_LANG_COOKIE = "admin_lang";
export const DEFAULT_ADMIN_LANG: AdminLang = "en";

export function isAdminLang(v: string): v is AdminLang {
  return ADMIN_LANGS.some((l) => l.id === v);
}

/** The admin's UI language: the picker cookie wins; first visits fall back to
 *  the browser's preferred language. */
export function adminLangFromRequest(request: Request): AdminLang {
  const cookie = request.headers.get("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)admin_lang=([^;\s]+)/);
  if (m && isAdminLang(m[1])) return m[1];
  const accept = (request.headers.get("Accept-Language") ?? "").trim().toLowerCase();
  if (accept.startsWith("de")) return "de";
  return DEFAULT_ADMIN_LANG;
}

export type AdminT = (key: string, vars?: Record<string, string | number>) => string;

export function adminT(lang: AdminLang): AdminT {
  const dict = lang === "en" ? undefined : DICTS[lang];
  return (key, vars) => {
    let s = dict?.[key] ?? EN[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

/** t() for components under the admin layout — reads the language the layout
 *  loader resolved, so pages don't each need loader plumbing. */
export function useAdminT(): AdminT {
  const data = useRouteLoaderData("routes/admin/layout") as { adminLang?: AdminLang } | undefined;
  return adminT(data?.adminLang ?? DEFAULT_ADMIN_LANG);
}

// ===== dictionaries =====
// EN is the source of truth: every key must exist here. Other languages may
// lag behind; missing keys render in English.

const EN: Record<string, string> = {
  // -- chrome: header --
  hideMenu: "Hide menu",
  showMenu: "Show menu",
  currentProperty: "Current property",
  selectProperty: "Select property",
  searchProperties: "Search properties…",
  noPropertiesMatch: "No properties match “{q}”",
  editingLangLabel: "Editing",
  adminLanguage: "Admin language",
  viewSite: "View site",
  signOut: "Sign out",

  // -- chrome: test-mode banner --
  testModeTitle: "Test mode.",
  testModeBody:
    "Bookings are simulated — nothing is sent to Channex and no payment is taken. Guests can’t really book yet.",
  activateLive: "Activate live bookings →",

  // -- chrome: nav --
  navOperations: "Operations",
  navSettings: "Settings",
  navPages: "Pages",
  navEmails: "Emails",
  navInventory: "Inventory",
  navAnalytics: "Analytics",
  navChangeLog: "Change log",
  navBookings: "Bookings",
  navReviews: "Reviews",
  navPropertyDetails: "Property details",
  navGeneral: "General",
  navPortal: "Customer Portal",
  navRooms: "Rooms",
  navRates: "Rates",
  navTaxes: "Taxes & Fees",
  navPromotions: "Promotions",
  navExtras: "Extras",
  navVouchers: "Vouchers",
  navConnectivity: "Connectivity",
  navGoogle: "Google",
  navWidget: "Website widget",
  navBrandKit: "Brand kit",
  navPayments: "Payments",
  navApiKeys: "API keys",
  navWebhooks: "Webhooks",
  navTeam: "Team",
  navProperties: "Properties",
  navCollections: "Collections",
  navUsers: "Users",
  navHome: "Home",
  navResults: "Results",
  navRoomDetail: "Room detail",
  navCheckout: "Checkout",
  navConfirmation: "Confirmation",
  navEmailSettings: "Settings",
  navEmailBookingConfirmation: "Booking confirmation",
  navEmailHostNotification: "New booking (to you)",
  navEmailBookingCancellation: "Cancellation (guest)",
  navEmailCancellationNotification: "Cancellation (to you)",
  navEmailBookingFailed: "Couldn't confirm (guest)",
  navEmailReviewRequest: "Review request",

  // -- login --
  loginCheckEmail: "Check your email",
  loginLinkSent:
    "We've emailed you a sign-in link. It expires in 15 minutes. If this is your first time, the link sets up your account.",
  loginTitle: "Sign in or sign up",
  loginIntro:
    "New here? Enter your email to create your account — no password, no sign-up form. We'll email you a magic link.",
  loginEmail: "Email",
  loginSend: "Send magic link",
  loginSending: "Sending…",

  // -- common --
  saveChanges: "Save changes",
  saving: "Saving…",
  saved: "✓ Saved",

  // -- home page editor --
  homeTitle: "Home page",
  homeIntro: "The text guests see on the landing page. Empty fields use the defaults shown.",
  homeEyebrow: "Eyebrow (small label above the heading)",
  homeHeading: "Heading",
  homeIntroField: "Intro paragraph",
  homeSearchButton: "Search button label",
  homePromoText: "Promo code link text",
  homePromoTextHint: "The collapsible “add a promo code” link shown above the search button.",
  homePromoPlaceholder: "Promo code box placeholder",
  homePromoPlaceholderHint: "The faint example text inside the promo-code box (e.g. SUMMER10).",
  homeHighlights: "Highlights",
  homeHighlightTitle: "Highlight {n} title",
  homeHighlightDesc: "Description",
  homeFeatureImage: "Feature image",
  homeFeatureImageHint: "The large image near the bottom of the landing page. Shared across all languages.",
  homeImageFormats: "JPG or PNG, up to 8MB.",
  homeRemoveImage: "Remove custom image",
};

const DE: Record<string, string> = {
  // -- chrome: header --
  hideMenu: "Menü ausblenden",
  showMenu: "Menü einblenden",
  currentProperty: "Aktuelle Unterkunft",
  selectProperty: "Unterkunft wählen",
  searchProperties: "Unterkünfte suchen…",
  noPropertiesMatch: "Keine Unterkünfte für „{q}“",
  editingLangLabel: "Inhalt",
  adminLanguage: "Adminsprache",
  viewSite: "Website ansehen",
  signOut: "Abmelden",

  // -- chrome: test-mode banner --
  testModeTitle: "Testmodus.",
  testModeBody:
    "Buchungen werden simuliert — nichts wird an Channex gesendet und keine Zahlung erfolgt. Gäste können noch nicht wirklich buchen.",
  activateLive: "Echte Buchungen aktivieren →",

  // -- chrome: nav --
  navOperations: "Betrieb",
  navSettings: "Einstellungen",
  navPages: "Seiten",
  navEmails: "E-Mails",
  navInventory: "Verfügbarkeit",
  navAnalytics: "Analysen",
  navChangeLog: "Änderungsprotokoll",
  navBookings: "Buchungen",
  navReviews: "Bewertungen",
  navPropertyDetails: "Unterkunftsdetails",
  navGeneral: "Allgemein",
  navPortal: "Kundenportal",
  navRooms: "Zimmer",
  navRates: "Raten",
  navTaxes: "Steuern & Gebühren",
  navPromotions: "Aktionen",
  navExtras: "Extras",
  navVouchers: "Gutscheine",
  navConnectivity: "Anbindung",
  navGoogle: "Google",
  navWidget: "Website-Widget",
  navBrandKit: "Brand-Kit",
  navPayments: "Zahlungen",
  navApiKeys: "API-Schlüssel",
  navWebhooks: "Webhooks",
  navTeam: "Team",
  navProperties: "Unterkünfte",
  navCollections: "Kollektionen",
  navUsers: "Benutzer",
  navHome: "Startseite",
  navResults: "Ergebnisse",
  navRoomDetail: "Zimmerdetails",
  navCheckout: "Checkout",
  navConfirmation: "Bestätigung",
  navEmailSettings: "Einstellungen",
  navEmailBookingConfirmation: "Buchungsbestätigung",
  navEmailHostNotification: "Neue Buchung (an Sie)",
  navEmailBookingCancellation: "Stornierung (Gast)",
  navEmailCancellationNotification: "Stornierung (an Sie)",
  navEmailBookingFailed: "Nicht bestätigt (Gast)",
  navEmailReviewRequest: "Bewertungsanfrage",

  // -- login --
  loginCheckEmail: "Prüfen Sie Ihre E-Mails",
  loginLinkSent:
    "Wir haben Ihnen einen Anmeldelink geschickt. Er läuft in 15 Minuten ab. Beim ersten Mal richtet der Link Ihr Konto ein.",
  loginTitle: "Anmelden oder registrieren",
  loginIntro:
    "Neu hier? Geben Sie Ihre E-Mail-Adresse ein, um Ihr Konto zu erstellen — kein Passwort, kein Formular. Wir senden Ihnen einen Magic Link.",
  loginEmail: "E-Mail",
  loginSend: "Magic Link senden",
  loginSending: "Wird gesendet…",

  // -- common --
  saveChanges: "Änderungen speichern",
  saving: "Speichern…",
  saved: "✓ Gespeichert",

  // -- home page editor --
  homeTitle: "Startseite",
  homeIntro: "Die Texte, die Gäste auf der Startseite sehen. Leere Felder verwenden die angezeigten Standards.",
  homeEyebrow: "Vorzeile (kleine Zeile über der Überschrift)",
  homeHeading: "Überschrift",
  homeIntroField: "Einleitungstext",
  homeSearchButton: "Beschriftung des Suchbuttons",
  homePromoText: "Text des Promo-Code-Links",
  homePromoTextHint: "Der ausklappbare „Promo-Code hinzufügen“-Link über dem Suchbutton.",
  homePromoPlaceholder: "Platzhalter im Promo-Code-Feld",
  homePromoPlaceholderHint: "Der blasse Beispieltext im Promo-Code-Feld (z. B. SOMMER10).",
  homeHighlights: "Highlights",
  homeHighlightTitle: "Titel von Highlight {n}",
  homeHighlightDesc: "Beschreibung",
  homeFeatureImage: "Großes Bild",
  homeFeatureImageHint: "Das große Bild im unteren Bereich der Startseite. Gilt für alle Sprachen.",
  homeImageFormats: "JPG oder PNG, bis zu 8 MB.",
  homeRemoveImage: "Eigenes Bild entfernen",
};

const DICTS: Record<Exclude<AdminLang, "en">, Record<string, string>> = { de: DE };
