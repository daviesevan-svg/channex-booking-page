// Editable page content (admin-overridable). Shared by the search screen and
// the admin editor so defaults stay in one place.

import type { CityTaxConfig, FeeRule, TaxRule } from "./pricing";

export interface Highlight {
  title: string;
  description: string;
}

export interface SearchContent {
  eyebrow?: string; // default derived from the property location
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

export type DeadlineUnit = "hours" | "days";

export interface SiteSettings {
  theme?: ThemeId | "custom";
  customColor?: string;
  customBg?: string;
  customDomain?: string;
  /** Links shown in the checkout consent line (rendered as links only when set). */
  termsUrl?: string;
  privacyUrl?: string;
  /** ISO currency code for all prices (e.g. GBP). Defaults to GBP when unset. */
  currency?: string;
  languages?: string[]; // enabled languages (always includes the default)
  /** When true, checkout pushes real bookings to Channex; when false it simulates.
   *  Unset (never saved) falls back to the ALLOW_LIVE_BOOKING env var. */
  liveBooking?: boolean;
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
  /** Default windows used when a rate plan doesn't set its own. */
  cancelDeadlineValue?: number;
  cancelDeadlineUnit?: DeadlineUnit;
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
  // ----- Check-in / check-out times -----
  /** "HH:MM" local check-in-from and check-out-by times. Shown to guests and
   *  emitted in Google structured data; default 15:00 / 11:00 when unset. */
  checkinTime?: string;
  checkoutTime?: string;
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
  // ----- Google Hotels structured data -----
  /** Emit Google Hotel price structured data (JSON-LD) on results/detail/checkout.
   *  undefined = on; set false to suppress. The hotel identifier sent to Google
   *  (HLF + structured data) is always the property id. */
  googleStructuredData?: boolean;
  // ----- Google Hotels ARI push (direct rooms/rates/discounts/availability) -----
  /** Master switch: push this property's ARI (property data, rates, availability,
   *  inventory, taxes, promotions) directly to Google. Off (default) = no push. */
  googleAriPush?: boolean;
  /** How many days ahead of today to push availability/rates for. Default 365.
   *  (The last-sync status lives in its own KV key — see GoogleAriSyncStatus in
   *  overrides.server — so automated status writes can't clobber settings.) */
  googleAriWindowDays?: number;
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

// ---- Translations of the built-in defaults ----
// English lives in DEFAULT_SEARCH / EDITABLE_PAGES; only non-English here.
// Machine-quality baseline — each hotel can refine it in the admin.
type SearchDefaults = typeof DEFAULT_SEARCH;

const SEARCH_TRANSLATIONS: Record<string, SearchDefaults> = {
  fr: {
    heading: "Réservez votre séjour",
    intro:
      "Réservez en direct pour profiter de nos meilleurs tarifs, de l'annulation gratuite sur les réservations flexibles et d'aucuns frais de réservation — à chaque fois.",
    promoText: "Ajouter un code promo ou entreprise",
    searchButton: "Rechercher",
    highlights: [
      { title: "Annulation gratuite", description: "Sur tous les tarifs flexibles, jusqu'à 24h avant l'arrivée." },
      { title: "Meilleur tarif garanti", description: "Un prix plus bas ailleurs ? Nous l'alignons." },
      { title: "Aucuns frais de réservation", description: "Le prix que vous voyez est le prix que vous payez." },
    ],
  },
  de: {
    heading: "Reservieren Sie Ihren Aufenthalt",
    intro:
      "Buchen Sie direkt für unsere besten verfügbaren Preise, kostenlose Stornierung bei flexiblen Buchungen und absolut keine Buchungsgebühren – jedes Mal.",
    promoText: "Promo- oder Firmencode hinzufügen",
    searchButton: "Zimmer suchen",
    highlights: [
      { title: "Kostenlose Stornierung", description: "Bei allen flexiblen Tarifen, bis 24 Std. vor Anreise." },
      { title: "Bestpreisgarantie", description: "Woanders günstiger? Wir ziehen mit." },
      { title: "Keine Buchungsgebühren", description: "Der angezeigte Preis ist der Preis, den Sie zahlen." },
    ],
  },
  es: {
    heading: "Reserve su estancia",
    intro:
      "Reserve directamente para obtener nuestras mejores tarifas disponibles, cancelación gratuita en reservas flexibles y sin gastos de reserva, siempre.",
    promoText: "Añadir un código promocional o corporativo",
    searchButton: "Buscar habitaciones",
    highlights: [
      { title: "Cancelación gratuita", description: "En todas las tarifas flexibles, hasta 24 h antes de la llegada." },
      { title: "Mejor tarifa garantizada", description: "¿Precio más bajo en otro sitio? Lo igualamos." },
      { title: "Sin gastos de reserva", description: "El precio que ve es el precio que paga." },
    ],
  },
  it: {
    heading: "Prenota il tuo soggiorno",
    intro:
      "Prenota direttamente per le nostre migliori tariffe disponibili, cancellazione gratuita sulle prenotazioni flessibili e nessun costo di prenotazione — ogni volta.",
    promoText: "Aggiungi un codice promozionale o aziendale",
    searchButton: "Cerca camere",
    highlights: [
      { title: "Cancellazione gratuita", description: "Su tutte le tariffe flessibili, fino a 24 ore prima dell'arrivo." },
      { title: "Miglior tariffa garantita", description: "Prezzo più basso altrove? Lo pareggiamo." },
      { title: "Nessun costo di prenotazione", description: "Il prezzo che vedi è il prezzo che paghi." },
    ],
  },
  pt: {
    heading: "Reserve a sua estadia",
    intro:
      "Reserve diretamente para obter as nossas melhores tarifas disponíveis, cancelamento gratuito em reservas flexíveis e sem taxas de reserva — sempre.",
    promoText: "Adicionar um código promocional ou empresarial",
    searchButton: "Procurar quartos",
    highlights: [
      { title: "Cancelamento gratuito", description: "Em todas as tarifas flexíveis, até 24h antes da chegada." },
      { title: "Melhor tarifa garantida", description: "Preço mais baixo noutro lado? Nós igualamos." },
      { title: "Sem taxas de reserva", description: "O preço que vê é o preço que paga." },
    ],
  },
  nl: {
    heading: "Reserveer uw verblijf",
    intro:
      "Boek rechtstreeks voor onze beste beschikbare tarieven, gratis annulering bij flexibele boekingen en helemaal geen boekingskosten — elke keer.",
    promoText: "Voeg een promo- of bedrijfscode toe",
    searchButton: "Zoek kamers",
    highlights: [
      { title: "Gratis annulering", description: "Op alle flexibele tarieven, tot 24 uur voor aankomst." },
      { title: "Beste prijsgarantie", description: "Elders goedkoper? Wij passen het aan." },
      { title: "Geen boekingskosten", description: "De prijs die u ziet, is de prijs die u betaalt." },
    ],
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
  },
  detail: {
    fr: { backLink: "Toutes les chambres", amenitiesTitle: "Dans cette chambre", rateTitle: "Choisissez votre tarif", addButton: "Ajouter à votre séjour" },
    de: { backLink: "Alle Zimmer", amenitiesTitle: "In diesem Zimmer", rateTitle: "Wählen Sie Ihren Tarif", addButton: "Zum Aufenthalt hinzufügen" },
    es: { backLink: "Todas las habitaciones", amenitiesTitle: "En esta habitación", rateTitle: "Elija su tarifa", addButton: "Añadir a su estancia" },
    it: { backLink: "Tutte le camere", amenitiesTitle: "In questa camera", rateTitle: "Scegli la tua tariffa", addButton: "Aggiungi al soggiorno" },
    pt: { backLink: "Todos os quartos", amenitiesTitle: "Neste quarto", rateTitle: "Escolha a sua tarifa", addButton: "Adicionar à estadia" },
    nl: { backLink: "Alle kamers", amenitiesTitle: "In deze kamer", rateTitle: "Kies uw tarief", addButton: "Toevoegen aan verblijf" },
  },
  checkout: {
    fr: { heading: "Vos coordonnées", guestSection: "Informations du client", arrivalSection: "Arrivée et demandes", paymentSection: "Paiement", paymentNote: "Votre tarif flexible est payé à l'hôtel. Nous avons seulement besoin d'une carte pour garantir la réservation — vous ne serez pas débité aujourd'hui.", completeButton: "Finaliser la réservation", cancellationNote: "Annulation gratuite jusqu'à 24h avant l'arrivée." },
    de: { heading: "Ihre Angaben", guestSection: "Gästeinformationen", arrivalSection: "Anreise & Wünsche", paymentSection: "Zahlung", paymentNote: "Ihr flexibler Tarif wird im Hotel bezahlt. Wir benötigen nur eine Karte zur Garantie der Buchung – heute wird nichts abgebucht.", completeButton: "Buchung abschließen", cancellationNote: "Kostenlose Stornierung bis 24 Std. vor Anreise." },
    es: { heading: "Sus datos", guestSection: "Información del huésped", arrivalSection: "Llegada y solicitudes", paymentSection: "Pago", paymentNote: "Su tarifa flexible se paga en el hotel. Solo necesitamos una tarjeta para garantizar la reserva: hoy no se le cobrará nada.", completeButton: "Completar la reserva", cancellationNote: "Cancelación gratuita hasta 24 h antes de la llegada." },
    it: { heading: "I tuoi dati", guestSection: "Informazioni dell'ospite", arrivalSection: "Arrivo e richieste", paymentSection: "Pagamento", paymentNote: "La tua tariffa flessibile si paga in hotel. Ci serve solo una carta per garantire la prenotazione — oggi non verrà addebitato nulla.", completeButton: "Completa la prenotazione", cancellationNote: "Cancellazione gratuita fino a 24 ore prima dell'arrivo." },
    pt: { heading: "Os seus dados", guestSection: "Informações do hóspede", arrivalSection: "Chegada e pedidos", paymentSection: "Pagamento", paymentNote: "A sua tarifa flexível é paga no hotel. Só precisamos de um cartão para garantir a reserva — não será cobrado hoje.", completeButton: "Concluir reserva", cancellationNote: "Cancelamento gratuito até 24h antes da chegada." },
    nl: { heading: "Uw gegevens", guestSection: "Gastinformatie", arrivalSection: "Aankomst & verzoeken", paymentSection: "Betaling", paymentNote: "Uw flexibele tarief wordt in het hotel betaald. We hebben alleen een kaart nodig om de boeking te garanderen — vandaag wordt er niets afgeschreven.", completeButton: "Boeking voltooien", cancellationNote: "Gratis annulering tot 24 uur voor aankomst." },
  },
  extras: {
    fr: { heading: "Améliorez votre {room}", intro: "Des extras facultatifs pour rendre votre séjour spécial.", stayTitle: "Pour tout votre séjour", summaryLabel: "Extras", continueButton: "Continuer", skipButton: "Passer pour l’instant" },
    de: { heading: "Verschönern Sie Ihr {room}", intro: "Optionale Extras für einen besonderen Aufenthalt.", stayTitle: "Für Ihren gesamten Aufenthalt", summaryLabel: "Extras", continueButton: "Weiter", skipButton: "Vorerst überspringen" },
    es: { heading: "Mejora tu {room}", intro: "Extras opcionales para hacer tu estancia especial.", stayTitle: "Para toda tu estancia", summaryLabel: "Extras", continueButton: "Continuar", skipButton: "Omitir por ahora" },
    it: { heading: "Arricchisci la tua {room}", intro: "Extra facoltativi per rendere speciale il tuo soggiorno.", stayTitle: "Per tutto il tuo soggiorno", summaryLabel: "Extra", continueButton: "Continua", skipButton: "Salta per ora" },
    pt: { heading: "Melhore o seu {room}", intro: "Extras opcionais para tornar a sua estadia especial.", stayTitle: "Para toda a sua estadia", summaryLabel: "Extras", continueButton: "Continuar", skipButton: "Ignorar por agora" },
    nl: { heading: "Maak je {room} compleet", intro: "Optionele extra’s om je verblijf bijzonder te maken.", stayTitle: "Voor je hele verblijf", summaryLabel: "Extra’s", continueButton: "Doorgaan", skipButton: "Nu overslaan" },
  },
  confirmation: {
    fr: { heading: "Tout est confirmé", subtitle: "Votre séjour à {hotel} est confirmé. Un e-mail de confirmation est en route.", newBooking: "Faire une autre réservation" },
    de: { heading: "Alles erledigt", subtitle: "Ihr Aufenthalt im {hotel} ist bestätigt. Eine Bestätigungs-E-Mail ist unterwegs.", newBooking: "Weitere Buchung vornehmen" },
    es: { heading: "Todo listo", subtitle: "Su estancia en {hotel} está confirmada. Un correo de confirmación está en camino.", newBooking: "Hacer otra reserva" },
    it: { heading: "Tutto pronto", subtitle: "Il tuo soggiorno presso {hotel} è confermato. Un'e-mail di conferma è in arrivo.", newBooking: "Effettua un'altra prenotazione" },
    pt: { heading: "Está tudo pronto", subtitle: "A sua estadia no {hotel} está confirmada. Um e-mail de confirmação está a caminho.", newBooking: "Fazer outra reserva" },
    nl: { heading: "Helemaal geregeld", subtitle: "Uw verblijf in {hotel} is bevestigd. Een bevestigingsmail is onderweg.", newBooking: "Nog een boeking maken" },
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
];

export function emailDef(id: string): EmailDef | undefined {
  return EMAIL_TEMPLATES.find((e) => e.id === id);
}

// English lives in the defaults above. Non-English templates fall back to
// English until an operator translates them via the ?lang editor (seed here).
const EMAIL_TRANSLATIONS: Record<string, Record<string, Record<string, string>>> = {};

/** Built-in email defaults for a language (English fields fill any gaps). */
export function emailDefaults(id: string, lang: string): Record<string, string> {
  const def = emailDef(id);
  const en: Record<string, string> = {};
  if (def) for (const f of def.fields) en[f.key] = f.default;
  if (lang === DEFAULT_LANG) return en;
  return { ...en, ...(EMAIL_TRANSLATIONS[id]?.[lang] ?? {}) };
}

/** Merge stored overrides over an email template's language-aware defaults. */
export function withEmailDefaults(
  id: string,
  overrides: Record<string, string | undefined> = {},
  lang: string = DEFAULT_LANG,
): Record<string, string> {
  const defaults = emailDefaults(id, lang);
  const out: Record<string, string> = {};
  for (const key of Object.keys(defaults)) out[key] = overrides[key]?.trim() || defaults[key];
  return out;
}
