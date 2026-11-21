// How each guest language writes a price and a date.
//
// BAKED, not Intl-per-locale, for the same reason MONEY_LOCALE exists (see
// money.ts): a price is rendered once in the Worker and again in the guest's
// browser, and the two ICU builds do not always agree — French grouping is
// U+202F in one and U+00A0 in another, some browsers ship pruned locale data.
// Any difference is a failed hydration and a price that visibly changes after
// the page loads. A table gives the same string on both sides by construction.
//
// The currency SYMBOL still comes from Intl's en-US data, exactly as before
// ("€", "£", "CA$", "฿"), so only the separators and where the symbol sits
// change. English is untouched: it returns en-US output verbatim.
//
// A new guest language without an entry falls back to English formatting, and
// locale-format.test.ts fails until one is added.

import { format, parseISO } from "date-fns";
import { enGB } from "date-fns/locale";

import { DATE_LOCALES } from "./locales/date-locales";

const NB = "\u00a0"; // no-break space: never let "1 083,60" / "€" wrap apart

export interface MoneyStyle {
  /** Thousands separator. */
  group: string;
  /** Decimal separator. */
  decimal: string;
  /** Symbol after the number ("54,00 €") rather than before ("€54.00"). */
  after: boolean;
  /** A space between a leading symbol and the number ("€ 54,00"). A trailing
   *  symbol always gets one, as does a leading alphabetic code ("CHF 54,00"). */
  spaceBefore?: boolean;
  /** Group only from five integer digits ("1083,60" but "10 830,00") — CLDR's
   *  minimumGroupingDigits 2 for es, pl, pt. */
  minGroup2?: boolean;
}

export const MONEY_STYLES: Record<string, MoneyStyle> = {
  en: { group: ",", decimal: ".", after: false },
  th: { group: ",", decimal: ".", after: false },
  cs: { group: NB, decimal: ",", after: true },
  sk: { group: NB, decimal: ",", after: true },
  pl: { group: NB, decimal: ",", after: true, minGroup2: true },
  pt: { group: NB, decimal: ",", after: true, minGroup2: true },
  fr: { group: NB, decimal: ",", after: true },
  de: { group: ".", decimal: ",", after: true },
  el: { group: ".", decimal: ",", after: true },
  it: { group: ".", decimal: ",", after: true },
  mk: { group: ".", decimal: ",", after: true },
  es: { group: ".", decimal: ",", after: true, minGroup2: true },
  nl: { group: ".", decimal: ",", after: false, spaceBefore: true },
  tr: { group: ".", decimal: ",", after: false },
};

/** Named date shapes. Call sites ask for a shape, never a pattern, so each
 *  language decides its own order, punctuation and month form. */
export type DateStyle =
  | "day" //       Mon 14 Dec        · po 14. 12.
  | "dayYear" //   Mon 14 Dec 2026   · po 14. 12. 2026
  | "short" //     14 Dec            · 14. 12.
  | "long" //      14 Dec 2026       · 14. 12. 2026
  | "longMonth" // 14 December 2026  · 14. decembra 2026
  | "dateTime" //  14 Dec 2026, 18:00
  | "month" //     December 2026 (a heading: the standalone month name)
  | "weekday" //   Mon
  | "weekdayLong"; // Monday

type Patterns = Record<DateStyle, string> & {
  /** The start of a range whose end is in the same month: "Mon 14" – "Wed 16 Dec". */
  rangeStart: string;
};

// `LLLL` (standalone) for headings: in Slovak, Czech, Polish, Greek and
// Macedonian the formatting form `MMMM` is the genitive — "decembra 2026" is
// "of December 2026". English and most others have one form, so it's harmless.
const DEFAULT_PATTERNS: Patterns = {
  day: "EEE d MMM",
  dayYear: "EEE d MMM yyyy",
  short: "d MMM",
  long: "d MMM yyyy",
  longMonth: "d MMMM yyyy",
  dateTime: "d MMM yyyy, HH:mm",
  month: "LLLL yyyy",
  weekday: "EEE",
  weekdayLong: "EEEE",
  rangeStart: "EEE d",
};

// Slovak and Czech write the day with a full stop and the month as a number
// ("14. – 16. 12."), the form the Slovak customer asked for.
const DOTTED_NUMERIC: Patterns = {
  ...DEFAULT_PATTERNS,
  day: "EEE d. M.",
  dayYear: "EEE d. M. yyyy",
  short: "d. M.",
  long: "d. M. yyyy",
  longMonth: "d. MMMM yyyy",
  dateTime: "d. M. yyyy, HH:mm",
  rangeStart: "EEE d.",
};

export const DATE_PATTERNS: Record<string, Patterns> = {
  en: DEFAULT_PATTERNS,
  sk: DOTTED_NUMERIC,
  cs: DOTTED_NUMERIC,
  de: {
    ...DEFAULT_PATTERNS,
    day: "EEE, d. MMM",
    dayYear: "EEE, d. MMM yyyy",
    short: "d. MMM",
    long: "d. MMM yyyy",
    longMonth: "d. MMMM yyyy",
    dateTime: "d. MMM yyyy, HH:mm",
    rangeStart: "EEE, d.",
  },
  pl: { ...DEFAULT_PATTERNS, day: "EEE, d MMM", dayYear: "EEE, d MMM yyyy", rangeStart: "EEE, d" },
  es: { ...DEFAULT_PATTERNS, day: "EEE, d MMM", dayYear: "EEE, d MMM yyyy", rangeStart: "EEE, d" },
  fr: DEFAULT_PATTERNS,
  it: DEFAULT_PATTERNS,
  pt: DEFAULT_PATTERNS,
  nl: DEFAULT_PATTERNS,
  el: DEFAULT_PATTERNS,
  mk: DEFAULT_PATTERNS,
  th: DEFAULT_PATTERNS,
  tr: {
    ...DEFAULT_PATTERNS,
    day: "d MMM EEE",
    dayYear: "d MMM yyyy EEE",
    rangeStart: "d",
  },
};

export function moneyStyle(lang: string): MoneyStyle {
  return MONEY_STYLES[lang] ?? MONEY_STYLES.en;
}

export function datePatterns(lang: string): Patterns {
  return DATE_PATTERNS[lang] ?? DEFAULT_PATTERNS;
}

/** The dash between two dates. Spaced en dash in every language. */
export const RANGE_DASH = " – ";

/** Format a date (YYYY-MM-DD / ISO string, or a Date) in a named shape for
 *  `lang`. Translator.date is this, bound to the guest's language. */
export function formatDate(d: string | Date, style: DateStyle, lang = "en"): string {
  return format(typeof d === "string" ? parseISO(d) : d, datePatterns(lang)[style], {
    locale: DATE_LOCALES[lang] ?? enGB,
  });
}
