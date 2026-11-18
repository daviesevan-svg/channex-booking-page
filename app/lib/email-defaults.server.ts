// Built-in guest-email copy in every guest language.
//
// `.server` on purpose: content.ts is in the client bundle (the admin editor
// reads the English field defaults from EMAIL_TEMPLATES), and ~150 translated
// paragraphs would ship to every guest browser for nothing — the same trap the
// admin dictionaries fell into before PR437. Emails are composed on the server
// only, so the translations live here.
//
// Only GUEST-facing templates are translated. Host-facing ones
// (host_notification, cancellation_notification) always render in the default
// language — the recipient is the hotelier, and their guest's language says
// nothing about theirs (email.server pins those sends to DEFAULT_LANG).
//
// Keep {tokens} byte-identical to the English defaults in content.ts, and keep
// any button named in prose (the confirmation outro quotes "Manage booking")
// in sync with that language's `manageBooking` label in app/lib/locales/*.
//
// The translations themselves are data: app/lib/locales/emails/<lang>.json,
// written by `npm run i18n:import` (scripts/i18n.mjs).
import { DEFAULT_LANG, emailDef } from "./content";
import { LOCALE_EMAILS } from "./locales/emails.server";

/** Built-in email defaults for a language (English fields fill any gaps). */
export function emailDefaults(id: string, lang: string): Record<string, string> {
  const def = emailDef(id);
  const en: Record<string, string> = {};
  if (def) for (const f of def.fields) en[f.key] = f.default;
  if (lang === DEFAULT_LANG) return en;
  return { ...en, ...(LOCALE_EMAILS[lang]?.[id] ?? {}) };
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
