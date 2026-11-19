// Shapes of the per-language data files written by `npm run i18n:import`
// (scripts/i18n.mjs). English lives in code (content.ts / email field defaults);
// these hold every other language, and a missing field falls back to English.

/** app/lib/locales/copy/<lang>.json */
export interface LocaleCopy {
  /** The language's own name, for the language picker (e.g. "Slovenčina"). */
  label: string;
  flag: string;
  /** Search-box defaults: heading, intro, promoText, searchButton. */
  search?: Record<string, string>;
  /** Page-copy defaults by page id (results, detail, checkout, extras, confirmation). */
  pages?: Record<string, Record<string, string>>;
  /** EU Art. 8(2) order-button wording. */
  euOrderButton?: string;
}

/** app/lib/locales/emails/<lang>.json — email id → field → text. */
export type LocaleEmails = Record<string, Record<string, string>>;
