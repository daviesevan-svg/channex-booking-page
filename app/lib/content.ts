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
  heroImage?: string; // language-independent; falls back to the Channex photo
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
  languages?: string[]; // enabled languages (always includes the default)
  // ----- Customer Portal (manage-my-booking) -----
  allowCancel?: boolean;
  allowModify?: boolean;
  /** Default windows used when a rate plan doesn't set its own. */
  cancelDeadlineValue?: number;
  cancelDeadlineUnit?: DeadlineUnit;
  modifyDeadlineValue?: number;
  modifyDeadlineUnit?: DeadlineUnit;
  /** Shown to guests once the cancel/modify deadline has passed. */
  afterDeadlineMessage?: string;
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
