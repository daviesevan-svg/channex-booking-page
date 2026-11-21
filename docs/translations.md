# Translating the booking engine

Every guest-facing string a language needs is in **one spreadsheet** per language.
You export it, send it to a translator, and import what comes back. The tool is `scripts/i18n.mjs`.

## Add a new language (e.g. Polish)

```bash
npm run i18n:export -- pl          # writes translations/pl.csv (about 630 rows)
```

Send `translations/pl.csv` to the translator. It opens in Excel, Google Sheets or any
CAT tool. Each row has:

| column | what it is |
|---|---|
| `id` | where the string goes; don't edit |
| `context` | the screen or section it appears on |
| `english` | the source text |
| `translation` | **the only column to fill in** |
| `notes` | `{placeholders}` to keep, which plural form the row is for, length hints |

Two rows are about the language itself: `meta.label` is its own name (e.g. "Polski"), and
`meta.flag` is a flag emoji for the picker.

When the file comes back (save as CSV, UTF-8):

```bash
npm run i18n:import -- translations/pl.csv
```

That's it. The import:

- **rejects the whole file** if any row breaks a `{placeholder}` or has an unknown id, and lists the rows;
- writes `app/lib/locales/pl.ts` (UI labels), `locales/copy/pl.json` (page and search
  defaults, picker name, EU order button) and `locales/emails/pl.json` (the 5 guest emails);
- regenerates the registries (`locales/copy.ts`, `dicts.server.ts`, `emails.server.ts`,
  `date-locales.ts`), so the language appears in the admin's language list, gets its
  date-fns locale and serves its emails. **No hand edits.**

Untranslated rows are fine: the import leaves them out and English shows instead. The import
tells you how many are left.

Then run `npm run typecheck && npm test` and open a page with `?lang=pl` (the hotel must have the
language enabled under its languages).

## Fill gaps in an existing language

New features add English strings. To send a translator only what's missing:

```bash
npm run i18n:export -- de --missing
npm run i18n:import -- translations/de.csv
```

Import merges, so rows you don't send keep their current translation.

## Admin UI

Same workflow with `--admin` (≈2,100 strings, written to `app/lib/admin-locales/<lang>.ts`):

```bash
npm run i18n:export -- de --admin --missing
npm run i18n:import -- translations/de-admin.csv
```

A brand-new **admin** language still needs registering by hand in `app/lib/admin-i18n.ts` and
`admin-i18n-locales.server.ts`. The import prints exactly what to add.

## Plurals

English has two forms (`night_one` "1 night", `night_other` "3 nights"). Languages with more get
extra rows automatically: Slovak, Czech, Polish and Russian get `_few` (2–4) and so on. The
forms come from `Intl.PluralRules`, the same rule the runtime uses (`pluralForm` in
`app/lib/i18n.ts`). A missing extra form falls back to `_other`.

## Prices and dates

How each language writes money ("54,00 €", "€ 54,00", "€54.00") and dates ("po 14. – st 16. 12.") is a
baked table in `app/lib/locale-format.ts`, not translator text: `MONEY_STYLES` (separators, symbol
position) and `DATE_PATTERNS` (date-fns patterns per named shape). A new language needs one entry in
each; `locale-format.test.ts` fails until it has them, and without one it formats like English.

Guest code formats through the translator: `tr.money(amount, currency)`, `tr.moneyParts`, `tr.date(iso,
"day" | "dayYear" | "short" | "long" | …)` and `tr.dateRange(checkin, checkout)`. `npm run typecheck`
runs `scripts/check-guest-formatting.mjs`, which fails on a bare `formatMoney(` or a hand-written
date pattern in guest code.

## Rules worth knowing

- Edit translations through the CSV, not the generated files. The next import rewrites
  `locales/<lang>.ts` in English's key order, with English's section comments.
- `translations/` is git-ignored working space; the code files are the source of truth.
  Export again any time to get a current spreadsheet, prefilled.
- `legal.euOrderButton` is legally required wording (EU Directive 2011/83, Art. 8(2)): it must say
  plainly that booking costs money. Don't let a copy pass soften it.
- Hotel-written content (room names, page text, custom emails) is per-property and edited in the
  admin. It isn't in these files.
